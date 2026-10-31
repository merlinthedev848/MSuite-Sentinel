import cv2
import json
import time
import os
import logging
from ultralytics import YOLO
import paho.mqtt.client as mqtt
from semantic_search import semantic_engine
from motion import motion_gate
from PIL import Image

# Force TCP RTSP transport and an 8-second socket timeout for OpenCV FFmpeg capture
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|timeout;8000000")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("mView-Detector")

MQTT_BROKER = os.getenv("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MODEL_NAME = os.getenv("DETECTOR_MODEL", "yolov8n.pt")
ACCELERATOR = os.getenv("ACCELERATOR", "cpu").lower()
FRAME_STRIDE = max(1, int(os.getenv("FRAME_STRIDE", "6")))
IMAGE_SIZE = int(os.getenv("IMAGE_SIZE", "640"))
MIN_CONFIDENCE = float(os.getenv("MIN_CONFIDENCE", "0.5"))
EVENT_COOLDOWN_SECONDS = float(os.getenv("EVENT_COOLDOWN_SECONDS", "5"))
ENABLE_MOTION_GATING = os.getenv("ENABLE_MOTION_GATING", "true").lower() in ("true", "1", "yes")
DETECT_CLASSES = [
    int(value)
    for value in os.getenv("DETECT_CLASSES", "0,2,3,5,7").split(",")
    if value.strip().isdigit()
]

CAMERA_ID = os.getenv("CAMERA_ID", "")
STREAM_URL = os.getenv("STREAM_URL", "")


def fetch_active_streams() -> list[tuple[str, str]]:
    """Query Sentinel NVR API to discover active camera stream RTSP URLs."""
    api_url = os.getenv("API_URL", "http://127.0.0.1:8000/cameras")
    try:
        import urllib.request
        req = urllib.request.Request(api_url, headers={"User-Agent": "Sentinel-Detector/1.0"})
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            if resp.status == 200:
                cams = json.loads(resp.read().decode())
                streams = []
                for c in cams:
                    cid = c.get("id")
                    if cid and c.get("status") in ("online", "recording"):
                        # Prefer go2rtc RTSP proxy stream
                        rtsp = f"rtsp://127.0.0.1:8554/{cid}"
                        streams.append((cid, rtsp))
                return streams
    except Exception:
        pass
    return []


class DetectorNode:
    def __init__(self):
        logger.info("Initializing YOLO model %s on %s...", MODEL_NAME, ACCELERATOR)
        self.model = YOLO(MODEL_NAME)
        if ACCELERATOR != "cpu":
            try:
                self.model.to(ACCELERATOR)
            except Exception as e:
                logger.warning("Could not move YOLO model to %s: %s. Falling back to default device.", ACCELERATOR, e)

        self.mqtt_client: mqtt.Client | None = None
        self._last_mqtt_attempt = 0.0
        self._ensure_mqtt()

        self.last_event_by_class: dict[str, float] = {}
        self.cooldown = EVENT_COOLDOWN_SECONDS
        self._stream_cursor = 0

    def _ensure_mqtt(self):
        if self.mqtt_client is not None:
            return
        now = time.time()
        if now - self._last_mqtt_attempt < 10.0:
            return
        self._last_mqtt_attempt = now
        logger.info(f"Connecting to MQTT Broker at {MQTT_BROKER}:{MQTT_PORT}...")
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        try:
            client.connect(MQTT_BROKER, MQTT_PORT, 60)
            client.loop_start()
            self.mqtt_client = client
        except Exception as e:
            logger.error(f"Failed to connect to MQTT: {e}")
            self.mqtt_client = None

    def run(self):
        self._ensure_mqtt()
        target_camera_id = CAMERA_ID
        target_url = STREAM_URL

        # If no explicit STREAM_URL is given or if default camera1 is set, auto-discover from API
        if not target_url or "camera1" in target_url:
            active_streams = fetch_active_streams()
            if active_streams:
                idx = self._stream_cursor % len(active_streams)
                self._stream_cursor += 1
                target_camera_id, target_url = active_streams[idx]
            else:
                logger.info("Waiting for adopted camera streams from Sentinel NVR...")
                time.sleep(15)
                return

        logger.info(f"Connecting to camera [{target_camera_id}] stream: {target_url}")
        cap = cv2.VideoCapture(target_url, cv2.CAP_FFMPEG)
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
            if not cap.isOpened():
                logger.info(f"Stream {target_url} not available yet. Retrying in 10s...")
                time.sleep(10)
                return

            frame_count = 0
            while cap.isOpened():
                frame_count += 1
                # Use grab() on non-stride frames to advance the demuxer without full frame decoding
                if frame_count % FRAME_STRIDE != 0:
                    if not cap.grab():
                        break
                    continue

                ret, frame = cap.read()
                if not ret or frame is None:
                    break

                # Motion gating pre-filter to skip idle frames without running heavy neural networks
                if ENABLE_MOTION_GATING and not motion_gate.has_motion(frame):
                    continue

                frame_h, frame_w = frame.shape[:2]

                # Run YOLO inference
                results = self.model(
                    frame,
                    verbose=False,
                    classes=DETECT_CLASSES,
                    conf=MIN_CONFIDENCE,
                    imgsz=IMAGE_SIZE,
                )

                detections = []
                for r in results:
                    boxes = r.boxes
                    for box in boxes:
                        conf = float(box.conf[0])
                        if conf < MIN_CONFIDENCE:
                            continue

                        cls_id = int(box.cls[0])
                        class_name = self.model.names[cls_id]
                        x1, y1, x2, y2 = map(int, box.xyxy[0])
                        x1, y1 = max(0, x1), max(0, y1)
                        x2, y2 = min(frame_w, x2), min(frame_h, y2)
                        if x2 <= x1 or y2 <= y1:
                            continue

                        # Generate Semantic Embedding for the detected object
                        try:
                            cropped = frame[y1:y2, x1:x2]
                            cropped_rgb = cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB)
                            pil_img = Image.fromarray(cropped_rgb)
                            embedding = semantic_engine.embed_image(pil_img)
                            embedding_list = embedding.tolist()
                        except Exception as e:
                            logger.error(f"Failed to generate embedding: {e}")
                            embedding_list = []

                        detections.append({
                            "class": class_name,
                            "confidence": conf,
                            "bbox": [x1, y1, x2, y2],
                            "bbox_norm": [
                                max(0, min(1, x1 / frame_w)),
                                max(0, min(1, y1 / frame_h)),
                                max(0, min(1, x2 / frame_w)),
                                max(0, min(1, y2 / frame_h)),
                            ],
                            "embedding": embedding_list
                        })

                if detections:
                    self.publish_event(detections, frame_w, frame_h, target_camera_id)
        finally:
            cap.release()

        logger.info("Stream connection lost or ended. Reconnecting in 5s...")
        time.sleep(5)

    def publish_event(self, detections, frame_w, frame_h, camera_id="default_cam"):
        self._ensure_mqtt()
        cam_id = camera_id or CAMERA_ID or "default_cam"
        now = time.time()
        publishable = []
        for detection in detections:
            object_class = detection.get("class", "object")
            cooldown_key = f"{cam_id}:{object_class}"
            last_seen = self.last_event_by_class.get(cooldown_key, 0)
            if now - last_seen >= self.cooldown:
                publishable.append(detection)
                self.last_event_by_class[cooldown_key] = now

        if not publishable:
            return

        # Prune stale cooldown entries if dictionary grows large
        if len(self.last_event_by_class) > 1000:
            cutoff = now - max(self.cooldown * 10, 300)
            self.last_event_by_class = {
                k: v for k, v in self.last_event_by_class.items() if v >= cutoff
            }

        payload = {
            "camera_id": cam_id,
            "timestamp": now,
            "frame": {"width": frame_w, "height": frame_h},
            "objects": publishable
        }
        topic = f"sentinel/events/{cam_id}"
        if self.mqtt_client:
            try:
                self.mqtt_client.publish(topic, json.dumps(payload, separators=(",", ":")), qos=0)
                logger.info(f"Published event with {len(publishable)} objects to {topic}")
            except Exception as e:
                logger.warning(f"MQTT publish failed ({e}); resetting client.")
                self.mqtt_client = None


if __name__ == "__main__":
    node = DetectorNode()
    while True:
        try:
            node.run()
        except Exception as e:
            logger.error(f"Detector crashed: {e}")
            time.sleep(5)
