import asyncio
import json
import logging
import os
import uuid
import aiofiles
import httpx
from aiomqtt import Client as MQTTClient
from api.database import async_session_maker
from api.models.ai import SemanticEvent
from api.models.camera import Camera
from api.config import settings
from api.services.local_core import local_core
from datetime import datetime, timezone

logger = logging.getLogger("mView-EventProcessor")


async def capture_snapshot(camera_id: str) -> bytes | None:
    """Fetch recent frame snapshot from go2rtc via async HTTP request."""
    url = f"{settings.go2rtc_url.rstrip('/')}/api/frame.jpeg?src={camera_id}"
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                return resp.content
    except Exception:
        pass
    return None

MQTT_BROKER = settings.mqtt_broker
MQTT_PORT = settings.mqtt_port
_LAST_ZONE_EVENTS: dict[tuple[str, str, str], float] = {}
_LAST_VLM_ANALYSIS: dict[str, float] = {}


def _point_in_polygon(x: float, y: float, points: list[dict]) -> bool:
    inside = False
    j = len(points) - 1
    for i, point in enumerate(points):
        xi, yi = float(point.get("x", 0)), float(point.get("y", 0))
        xj, yj = float(points[j].get("x", 0)), float(points[j].get("y", 0))
        intersects = ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) or 0.000001) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def _normalized_bbox(obj: dict, frame: dict | None) -> list[float] | None:
    bbox_norm = obj.get("bbox_norm")
    if isinstance(bbox_norm, list) and len(bbox_norm) == 4:
        return [float(v) for v in bbox_norm]

    bbox = obj.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4 or not frame:
        return None

    width = float(frame.get("width") or 0)
    height = float(frame.get("height") or 0)
    if width <= 0 or height <= 0:
        return None

    x1, y1, x2, y2 = [float(v) for v in bbox]
    return [
        max(0, min(1, x1 / width)),
        max(0, min(1, y1 / height)),
        max(0, min(1, x2 / width)),
        max(0, min(1, y2 / height)),
    ]


def _matching_zone(obj: dict, zones: list[dict], frame: dict | None) -> dict | None:
    if not zones:
        return {}

    class_name = str(obj.get("class") or "").lower()
    confidence = float(obj.get("confidence") or 0)
    bbox = _normalized_bbox(obj, frame)
    center = ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2) if bbox else None

    for zone in zones:
        if zone.get("enabled") is False:
            continue
        objects = [str(v).lower() for v in zone.get("objects", [])]
        if objects and class_name not in objects:
            continue
        if confidence < float(zone.get("min_confidence") or 0):
            continue

        points = zone.get("points") or []
        if len(points) >= 3:
            if not center or not _point_in_polygon(center[0], center[1], points):
                continue

        return zone

    return None


async def process_mqtt_events():
    """
    Background task that listens to MQTT events from the AI Detector
    and persists them into the database with async processing.
    """
    logger.info(f"Connecting to MQTT Broker at {MQTT_BROKER}:{MQTT_PORT} to subscribe to events...")
    
    while True:
        try:
            async with MQTTClient(MQTT_BROKER, port=MQTT_PORT) as client:
                await client.subscribe("sentinel/events/#")
                logger.info("Subscribed to sentinel/events/#")
                
                async for message in client.messages:
                    payload = message.payload.decode()
                    
                    try:
                        data = json.loads(payload)
                        camera_id = data.get("camera_id")
                        objects = data.get("objects", [])
                        frame = data.get("frame") or {}
                        
                        raw_ts = data.get("timestamp")
                        if raw_ts:
                            event_timestamp = datetime.fromtimestamp(raw_ts, tz=timezone.utc)
                        else:
                            event_timestamp = datetime.now(timezone.utc)

                        if not objects:
                            continue

                        if not camera_id:
                            logger.warning("Skipping MQTT event without camera_id")
                            continue

                        async with async_session_maker() as session:
                            zones = []
                            camera = await session.get(Camera, camera_id)
                            if not camera:
                                logger.warning(f"Skipping event for unknown camera {camera_id}")
                                continue
                            if camera and isinstance(camera.config, dict):
                                zones = camera.config.get("zones") or []

                            # VLM Scene Interpretation (throttled to at most once per 10s per camera)
                            vlm_result = None
                            snapshot_bytes = None
                            rtsp_url = camera.rtsp_url_sub or camera.rtsp_url_main
                            now_ts = datetime.now(timezone.utc).timestamp()
                            last_vlm = _LAST_VLM_ANALYSIS.get(camera_id, 0)
                            if rtsp_url and objects and (now_ts - last_vlm >= 10.0):
                                _LAST_VLM_ANALYSIS[camera_id] = now_ts
                                detected_classes = [obj.get("class", "object") for obj in objects]
                                try:
                                    snapshot_bytes = await capture_snapshot(camera_id)
                                    if not snapshot_bytes:
                                        logger.warning(f"[WATCHDOG Alert] Signal loss detected on camera {camera_id}")
                                        try:
                                            from api.models.operations import AlertRule
                                            from api.services.notification_service import notification_service
                                            watchdog_rules = (await session.execute(select(AlertRule).where(AlertRule.enabled == True))).scalars().all()
                                            for wr in watchdog_rules:
                                                cfg = wr.config or {}
                                                if cfg.get("trigger_event") == "signal_loss" and (cfg.get("camera_id") in (None, camera_id)):
                                                    event_info = {"camera_id": camera_id, "object_class": "SIGNAL_LOSS", "confidence": 1.0, "timestamp": event_timestamp.isoformat()}
                                                    rule_payload = {"channels": ["webhook"] if cfg.get("webhook_url") else [], "webhook_url": cfg.get("webhook_url"), "mqtt_topic": cfg.get("mqtt_topic")}
                                                    if cfg.get("mqtt_topic"): rule_payload["channels"].append("mqtt")
                                                    asyncio.create_task(notification_service.dispatch(rule_payload, event_info))
                                        except Exception as w_err:
                                            logger.error(f"Failed to dispatch signal loss alert: {w_err}")

                                    elif len(snapshot_bytes) < 300:
                                        logger.warning(f"[WATCHDOG Alert] Camera tampering / lens obstruction detected on camera {camera_id}")
                                        try:
                                            from api.models.operations import AlertRule
                                            from api.services.notification_service import notification_service
                                            watchdog_rules = (await session.execute(select(AlertRule).where(AlertRule.enabled == True))).scalars().all()
                                            for wr in watchdog_rules:
                                                cfg = wr.config or {}
                                                if cfg.get("trigger_event") == "camera_tampered" and (cfg.get("camera_id") in (None, camera_id)):
                                                    event_info = {"camera_id": camera_id, "object_class": "TAMPERING", "confidence": 1.0, "timestamp": event_timestamp.isoformat()}
                                                    rule_payload = {"channels": ["webhook"] if cfg.get("webhook_url") else [], "webhook_url": cfg.get("webhook_url"), "mqtt_topic": cfg.get("mqtt_topic")}
                                                    if cfg.get("mqtt_topic"): rule_payload["channels"].append("mqtt")
                                                    asyncio.create_task(notification_service.dispatch(rule_payload, event_info))
                                        except Exception as w_err:
                                            logger.error(f"Failed to dispatch tampering alert: {w_err}")
                                    
                                    if snapshot_bytes:
                                        from api.services.vlm_service import vlm_service
                                        vlm_result = await vlm_service.analyze_frame(snapshot_bytes, detected_classes)
                                except Exception as err:
                                    logger.error(f"VLM snapshot analysis failed: {err}")

                            saved_count = 0
                            for obj in objects:
                                zone = _matching_zone(obj, zones, frame)
                                if zone is None:
                                    continue

                                # Only store embedding if it's the expected 512-dim vector
                                embedding = obj.get("embedding")
                                if not isinstance(embedding, list) or len(embedding) != 512:
                                    embedding = None

                                object_class = obj.get("class") or "unknown"
                                if vlm_result and vlm_result.get("description"):
                                    object_class = f"{object_class}: {vlm_result['description']}"
                                elif zone and zone.get("name"):
                                    object_class = f"{object_class} @ {zone.get('name')}"
                                    
                                zone_id = str(zone.get("id") or "global")
                                cooldown = float(zone.get("cooldown_seconds") or 60.0)
                                cooldown_key = (str(camera_id), zone_id, str(obj.get("class") or "object"))
                                last_seen = _LAST_ZONE_EVENTS.get(cooldown_key, 0)
                                event_time = event_timestamp.timestamp()
                                if event_time - last_seen < cooldown:
                                    continue
                                _LAST_ZONE_EVENTS[cooldown_key] = event_time

                                event_id = str(uuid.uuid4())
                                thumb_path = None
                                if snapshot_bytes:
                                    os.makedirs(settings.thumbnail_path, exist_ok=True)
                                    thumb_path = os.path.join(settings.thumbnail_path, f"{event_id}.jpg")
                                    async with aiofiles.open(thumb_path, "wb") as f:
                                        await f.write(snapshot_bytes)
                                
                                session.add(SemanticEvent(
                                    id=event_id,
                                    camera_id=camera_id,
                                    embedding=embedding,
                                    object_class=object_class,
                                    confidence=obj.get("confidence"),
                                    timestamp=event_timestamp,
                                    thumbnail_path=thumb_path
                                ))
                                saved_count += 1
                                
                                # Evaluate active database AlertRules and Automations
                                try:
                                    from api.models.operations import AlertRule
                                    from api.services.notification_service import notification_service
                                    active_rules = (await session.execute(select(AlertRule).where(AlertRule.enabled == True))).scalars().all()
                                    raw_class = str(obj.get("class") or "").lower()
                                    event_data = {
                                        "event_id": event_id,
                                        "camera_id": camera_id,
                                        "object_class": object_class,
                                        "confidence": obj.get("confidence"),
                                        "timestamp": event_timestamp.isoformat(),
                                        "threat_level": (vlm_result or {}).get("threat_level", "LOW")
                                    }

                                    for rule_record in active_rules:
                                        rcfg = rule_record.config or {}
                                        # Match automation rule or alert rule
                                        trigger_evt = rcfg.get("trigger_event", "")
                                        rule_objs = [str(o).lower() for o in rcfg.get("objects", [])]
                                        cam_filter = rcfg.get("camera_id") or rcfg.get("camera_ids", [])
                                        
                                        cam_matches = True
                                        if isinstance(cam_filter, list) and cam_filter:
                                            cam_matches = camera_id in cam_filter
                                        elif isinstance(cam_filter, str) and cam_filter:
                                            cam_matches = (cam_filter == camera_id)

                                        if not cam_matches:
                                            continue

                                        matches = False
                                        if trigger_evt in ("person_detected", "motion") and raw_class in ("person", "car", "truck", "motorcycle"):
                                            matches = True
                                        elif raw_class in rule_objs or not rule_objs:
                                            matches = True

                                        if matches:
                                            rule_channels = []
                                            if rcfg.get("webhook_url"):
                                                rule_channels.append("webhook")
                                            if rcfg.get("mqtt_topic"):
                                                rule_channels.append("mqtt")
                                            dispatch_payload = {
                                                "channels": rule_channels,
                                                "webhook_url": rcfg.get("webhook_url"),
                                                "mqtt_topic": rcfg.get("mqtt_topic"),
                                            }
                                            if rule_channels:
                                                asyncio.create_task(notification_service.dispatch(dispatch_payload, event_data))

                                    # Also check default environment channels for HIGH threat
                                    if vlm_result and vlm_result.get("threat_level") in ("MEDIUM", "HIGH"):
                                        default_webhook = os.getenv("DEFAULT_DISCORD_WEBHOOK")
                                        default_bot_token = os.getenv("DEFAULT_TELEGRAM_BOT_TOKEN")
                                        default_chat_id = os.getenv("DEFAULT_TELEGRAM_CHAT_ID")
                                        def_channels = []
                                        if default_webhook: def_channels.append("discord")
                                        if default_bot_token and default_chat_id: def_channels.append("telegram")
                                        if def_channels:
                                            asyncio.create_task(notification_service.dispatch({
                                                "channels": def_channels,
                                                "webhook_url": default_webhook,
                                                "bot_token": default_bot_token,
                                                "chat_id": default_chat_id
                                            }, event_data))
                                except Exception as alert_err:
                                    logger.error(f"Failed to dispatch smart alert: {alert_err}")

                                    
                            await session.commit()
                            if saved_count:
                                await local_core.publish("ai_event", {
                                    "camera_id": camera_id,
                                    "count": saved_count,
                                    "timestamp": event_timestamp.isoformat(),
                                })
                                logger.info(f"Saved {saved_count} events to database with embeddings.")
                            
                    except json.JSONDecodeError:
                        logger.error("Failed to decode MQTT payload")
                    except Exception as db_err:
                        logger.error(f"Database error while saving event: {db_err}")
                        
        except asyncio.CancelledError:
            logger.info("MQTT event processor cancelled.")
            raise
        except Exception as e:
            logger.error(f"MQTT connection lost: {e}. Reconnecting in 5 seconds...")
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(process_mqtt_events())

