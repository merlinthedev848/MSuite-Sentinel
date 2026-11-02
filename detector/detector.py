import base64
import json
import time
import os
import logging

# Read before OpenCV opens the capture. The default 5s probe is what made the
# first decoded frame late; the socket timeout is separate from that probe.
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|timeout;5000000|analyzeduration;0|probesize;32768",
)

import cv2
from ultralytics import YOLO
import paho.mqtt.client as mqtt
from semantic_search import semantic_engine
from motion import motion_gate
from PIL import Image

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


def _detection_jpeg(frame) -> str | None:
    """JPEG of the frame YOLO just scored, small enough for one MQTT message."""
    try:
        height, width = frame.shape[:2]
        scale = 640 / max(width, height)
        image = frame
        if scale < 1:
            image = cv2.resize(
                frame,
                (max(1, int(width * scale)), max(1, int(height * scale))),
                interpolation=cv2.INTER_AREA,
            )
        ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
        if not ok:
            return None
        blob = encoded.tobytes()
        if len(blob) > 180_000:
            ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 40])
            if not ok:
                return None
            blob = encoded.tobytes()
        if len(blob) > 180_000 or not blob.startswith(b"\xff\xd8"):
            return None
        return base64.b64encode(blob).decode("ascii")
    except Exception as exc:
        logger.warning("Could not encode detection JPEG: %s", exc)
        return None


def _service_token() -> str:
    token = os.getenv("SENTINEL_SERVICE_TOKEN", "").strip()
    if token:
        return token
    secrets_dir = os.getenv("SENTINEL_SECRETS_DIR", "/run/sentinel/secrets")
    path = os.path.join(secrets_dir, "service_token")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def fetch_active_streams() -> list[tuple[str, str]]:
    """Ask the API for every camera that has a stream, including ones still marked offline."""
    api_url = os.getenv("API_URL", "http://127.0.0.1:8000/cameras")
    try:
        import urllib.request
        headers = {"User-Agent": "Sentinel-Detector/1.0"}
        token = _service_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            if resp.status == 200:
                cams = json.loads(resp.read().decode())
                streams = []
                for cam in cams:
                    cid = cam.get("id")
                    has_stream = bool(cam.get("rtsp_url_main") or cam.get("rtsp_url_sub"))
                    if cid and has_stream and cam.get("enabled", True):
                        streams.append((cid, f"rtsp://127.0.0.1:8554/{cid}"))
                return streams
    except Exception as exc:
        logger.warning("Camera discovery failed: %s", exc)
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
        self._motion_camera = ""

    def _ensure_mqtt(self):
        if self.mqtt_client is not None:
            return
        now = time.time()
        if now - self._last_mqtt_attempt < 10.0:
            return
        self._last_mqtt_attempt = now
        logger.info(f"Connecting to MQTT Broker at {MQTT_BROKER}:{MQTT_PORT}...")
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        username = os.getenv("MQTT_USERNAME", "").strip()
        password = os.getenv("MQTT_PASSWORD", "")
        if username:
            client.username_pw_set(username, password)
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

        # The compose placeholder "camera1" is not a real camera. Rotate through
        # every discovered stream, including cameras whose status is still offline.
        placeholder = (not target_url) or ("camera1" in target_url)
        active_streams = fetch_active_streams()
        if active_streams:
            idx = self._stream_cursor % len(active_streams)
            self._stream_cursor += 1
            target_camera_id, target_url = active_streams[idx]
        elif placeholder:
            logger.info("Waiting for adopted camera streams from Sentinel NVR...")
            time.sleep(15)
            return

        if target_camera_id != self._motion_camera:
            motion_gate.reset()
            self._motion_camera = target_camera_id
        logger.info(f"Connecting to camera [{target_camera_id}] stream: {target_url}")
        cap = cv2.VideoCapture(target_url, cv2.CAP_FFMPEG)
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
            if not cap.isOpened():
                logger.info(f"Stream {target_url} not available yet. Retrying in 10s...")
                time.sleep(10)
                return

            frame_count = 0
            decoded = 0
            frames_per_camera = max(1, int(os.getenv("FRAMES_PER_CAMERA", "48")))
            last_heartbeat = 0.0
            while cap.isOpened():
                frame_count += 1
                now = time.time()
                if now - last_heartbeat >= 15.0:
                    last_heartbeat = now
                    self.publish_heartbeat(target_camera_id)
                # Use grab() on non-stride frames to advance the demuxer without full frame decoding
                if frame_count % FRAME_STRIDE != 0:
                    if not cap.grab():
                        break
                    continue

                ret, frame = cap.read()
                if not ret or frame is None:
                    break
                decoded += 1
                if decoded >= frames_per_camera:
                    logger.info("Finished %s frames on %s; moving to the next camera", decoded, target_camera_id)
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
                            embedding_list = embedding.tolist() if embedding is not None else None
                        except Exception as e:
                            logger.error(f"Failed to generate embedding: {e}")
                            embedding_list = None

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
                        })
                        if embedding_list:
                            detections[-1]["embedding"] = embedding_list

                if detections:
                    self.publish_event(detections, frame, frame_w, frame_h, target_camera_id)
        finally:
            cap.release()

        logger.info("Stream connection lost or ended. Reconnecting in 5s...")
        time.sleep(5)

    def publish_heartbeat(self, camera_id: str):
        self._ensure_mqtt()
        if not self.mqtt_client:
            return
        payload = {
            "camera_id": camera_id or CAMERA_ID or "default_cam",
            "timestamp": time.time(),
            "heartbeat": True,
            "objects": [],
        }
        try:
            self.mqtt_client.publish(
                f"sentinel/events/{payload['camera_id']}",
                json.dumps(payload, separators=(",", ":")),
                qos=1,
            )
        except Exception as exc:
            logger.warning("Heartbeat publish failed: %s", exc)
            self.mqtt_client = None

    def publish_event(self, detections, frame, frame_w, frame_h, camera_id="default_cam"):
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
            "objects": publishable,
        }
        jpeg = _detection_jpeg(frame)
        if jpeg:
            payload["jpeg"] = jpeg
        topic = f"sentinel/events/{cam_id}"
        if self.mqtt_client:
            body = json.dumps(payload, separators=(",", ":"))
            try:
                self.mqtt_client.publish(topic, body, qos=1)
                logger.info(f"Published event with {len(publishable)} objects to {topic}")
            except Exception as e:
                logger.warning(f"MQTT publish failed ({e}); retrying without the frame.")
                payload.pop("jpeg", None)
                try:
                    self.mqtt_client.publish(topic, json.dumps(payload, separators=(",", ":")), qos=1)
                except Exception as again:
                    logger.warning(f"MQTT publish failed ({again}); resetting client.")
                    self.mqtt_client = None


if __name__ == "__main__":
    node = DetectorNode()
    while True:
        try:
            node.run()
        except Exception as e:
            logger.error(f"Detector crashed: {e}")
            time.sleep(5)
