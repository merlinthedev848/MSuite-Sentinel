import asyncio
import json
import logging
import os
import time
import uuid
import aiofiles
import httpx
from aiomqtt import Client as MQTTClient
from sqlalchemy import select
from api.database import async_session_maker
from api.models.ai import SemanticEvent
from api.models.camera import Camera
from api.models.operations import AlertRule, PrivacyMode
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
_LAST_SEEN: dict[str, float] = {}
_SIGNAL_ALERTED: dict[str, float] = {}
_NOTIFY_LIMIT = asyncio.Semaphore(8)


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


def _rule_matches(trigger: str, raw_class: str, rule_objects: list[str]) -> bool:
    """Match an alert rule without treating every class as a person or as a hit."""
    if trigger == "person_detected":
        return raw_class == "person"
    if trigger == "motion":
        return bool(raw_class)
    if not rule_objects:
        return False
    return raw_class in rule_objects


def _camera_selected(camera_id: str, camera_filter) -> bool:
    if isinstance(camera_filter, list) and camera_filter:
        return camera_id in camera_filter
    if isinstance(camera_filter, str) and camera_filter:
        return camera_filter == camera_id
    return True


def _privacy_blocks(camera_id: str, modes: list) -> bool:
    for mode in modes:
        cfg = mode.config or {}
        selected = cfg.get("camera_ids") or cfg.get("camera_id")
        if not selected:
            return True
        if isinstance(selected, str) and selected == camera_id:
            return True
        if isinstance(selected, list) and camera_id in selected:
            return True
    return False


def _mqtt_client() -> MQTTClient:
    kwargs = {"keepalive": 30}
    if settings.mqtt_username:
        kwargs["username"] = settings.mqtt_username
        kwargs["password"] = settings.mqtt_password or None
    return MQTTClient(MQTT_BROKER, port=MQTT_PORT, **kwargs)


async def _dispatch(rule_config: dict, event_data: dict) -> None:
    from api.services.notification_service import notification_service

    channels = []
    if rule_config.get("webhook_url"):
        channels.append("webhook")
    if rule_config.get("mqtt_topic"):
        channels.append("mqtt")
    if not channels:
        return
    payload = {
        "channels": channels,
        "webhook_url": rule_config.get("webhook_url"),
        "mqtt_topic": rule_config.get("mqtt_topic"),
    }

    async def _run():
        async with _NOTIFY_LIMIT:
            await notification_service.dispatch(payload, event_data)

    asyncio.create_task(_run())


async def _persist_detection(data: dict) -> None:
    camera_id = data.get("camera_id")
    objects = data.get("objects") or []
    frame = data.get("frame") or {}
    if not camera_id:
        logger.warning("Skipping MQTT event without camera_id")
        return
    _LAST_SEEN[str(camera_id)] = time.time()
    if data.get("heartbeat") or not objects:
        return

    raw_ts = data.get("timestamp")
    event_timestamp = (
        datetime.fromtimestamp(raw_ts, tz=timezone.utc)
        if raw_ts else datetime.now(timezone.utc)
    )

    async with async_session_maker() as session:
        camera = await session.get(Camera, camera_id)
        if not camera:
            logger.warning("Skipping event for unknown camera %s", camera_id)
            return
        zones = camera.config.get("zones") if isinstance(camera.config, dict) else []
        zones = zones or []
        has_rtsp = bool(camera.rtsp_url_sub or camera.rtsp_url_main)
        privacy_modes = (await session.execute(
            select(PrivacyMode).where(PrivacyMode.enabled == True)
        )).scalars().all()
        if _privacy_blocks(str(camera_id), privacy_modes):
            logger.info("Privacy mode is active for camera %s; detection was not stored", camera_id)
            return
        rules = (await session.execute(
            select(AlertRule).where(AlertRule.enabled == True)
        )).scalars().all()
        rule_configs = [dict(rule.config or {}) for rule in rules]

    vlm_result = None
    snapshot_bytes = None
    now_ts = time.time()
    if has_rtsp and now_ts - _LAST_VLM_ANALYSIS.get(camera_id, 0) >= 10.0:
        _LAST_VLM_ANALYSIS[camera_id] = now_ts
        detected_classes = [obj.get("class", "object") for obj in objects]
        try:
            snapshot_bytes = await capture_snapshot(camera_id)
            if snapshot_bytes:
                from api.services.vlm_service import vlm_service
                vlm_result = await vlm_service.analyze_frame(snapshot_bytes, detected_classes)
        except Exception as err:
            logger.error("VLM snapshot analysis failed: %s", err)

    saved_count = 0
    async with async_session_maker() as session:
        for obj in objects:
            zone = _matching_zone(obj, zones, frame)
            if zone is None:
                continue
            object_class = obj.get("class") or "unknown"
            if vlm_result and vlm_result.get("description"):
                label = f"{object_class}: {vlm_result['description']}"
                if vlm_result.get("engine"):
                    label = f"{label} ({vlm_result['engine']})"
                object_class = label
            elif zone and zone.get("name"):
                object_class = f"{object_class} @ {zone.get('name')}"

            zone_id = str(zone.get("id") or "global")
            cooldown = float(zone.get("cooldown_seconds") or 60.0)
            cooldown_key = (str(camera_id), zone_id, str(obj.get("class") or "object"))
            event_time = event_timestamp.timestamp()
            if event_time - _LAST_ZONE_EVENTS.get(cooldown_key, 0) < cooldown:
                continue
            _LAST_ZONE_EVENTS[cooldown_key] = event_time

            event_id = str(uuid.uuid4())
            thumb_path = None
            if snapshot_bytes:
                try:
                    os.makedirs(settings.thumbnail_path, exist_ok=True)
                    thumb_path = os.path.join(settings.thumbnail_path, f"{event_id}.jpg")
                    async with aiofiles.open(thumb_path, "wb") as handle:
                        await handle.write(snapshot_bytes)
                except OSError as exc:
                    logger.warning("Could not store thumbnail: %s", exc)
                    thumb_path = None

            session.add(SemanticEvent(
                id=event_id,
                camera_id=camera_id,
                embedding=None,
                object_class=object_class,
                confidence=obj.get("confidence"),
                timestamp=event_timestamp,
                thumbnail_path=thumb_path,
            ))
            saved_count += 1
            raw_class = str(obj.get("class") or "").lower()
            event_data = {
                "event_id": event_id,
                "camera_id": camera_id,
                "object_class": object_class,
                "confidence": obj.get("confidence"),
                "timestamp": event_timestamp.isoformat(),
                "threat_level": (vlm_result or {}).get("threat_level", "LOW"),
            }
            for rule_config in rule_configs:
                trigger = rule_config.get("trigger_event", "")
                rule_objects = [str(item).lower() for item in rule_config.get("objects", [])]
                camera_filter = rule_config.get("camera_id") or rule_config.get("camera_ids", [])
                if not _camera_selected(str(camera_id), camera_filter):
                    continue
                if _rule_matches(trigger, raw_class, rule_objects):
                    await _dispatch(rule_config, event_data)
        await session.commit()

    if saved_count:
        await local_core.publish("ai_event", {
            "camera_id": camera_id,
            "count": saved_count,
            "timestamp": event_timestamp.isoformat(),
        })
        logger.info("Saved %s detection(s) for camera %s", saved_count, camera_id)


async def process_mqtt_events():
    """Listen for detector events. A failed snapshot is not treated as signal loss."""
    logger.info("Connecting to MQTT broker at %s:%s", MQTT_BROKER, MQTT_PORT)
    mqtt_backoff = 2
    while True:
        try:
            async with _mqtt_client() as client:
                mqtt_backoff = 2
                await client.subscribe("sentinel/events/#", qos=1)
                logger.info("Subscribed to sentinel/events/#")
                async for message in client.messages:
                    try:
                        payload = message.payload.decode()
                        data = json.loads(payload)
                        await _persist_detection(data)
                    except json.JSONDecodeError:
                        logger.error("Failed to decode MQTT payload")
                    except Exception as exc:
                        logger.error("Error while saving event: %s", exc)
        except asyncio.CancelledError:
            logger.info("MQTT event processor cancelled.")
            raise
        except Exception as exc:
            logger.error("MQTT connection lost: %s. Reconnecting in %ss", exc, mqtt_backoff)
            await asyncio.sleep(mqtt_backoff)
            mqtt_backoff = min(mqtt_backoff * 2, 60)


async def signal_watchdog():
    """Flag a camera that has an RTSP URL and has produced no detector heartbeat."""
    await asyncio.sleep(90)
    while True:
        try:
            now = time.time()
            async with async_session_maker() as session:
                cameras = (await session.execute(select(Camera).where(Camera.enabled == True))).scalars().all()
                watched = [(cam.id, cam.name) for cam in cameras if cam.rtsp_url_main]
                rules = (await session.execute(
                    select(AlertRule).where(AlertRule.enabled == True)
                )).scalars().all()
                signal_rules = [
                    dict(rule.config or {})
                    for rule in rules
                    if (rule.config or {}).get("trigger_event") == "signal_loss"
                ]
            for camera_id, _name in watched:
                last = _LAST_SEEN.get(camera_id)
                if last is None:
                    _LAST_SEEN[camera_id] = now
                    continue
                if now - last < 90 or now - _SIGNAL_ALERTED.get(camera_id, 0) < 300:
                    continue
                _SIGNAL_ALERTED[camera_id] = now
                logger.warning("Signal loss: camera %s has sent no frames", camera_id)
                event_info = {
                    "camera_id": camera_id,
                    "object_class": "SIGNAL_LOSS",
                    "confidence": 1.0,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                for rule_config in signal_rules:
                    if _camera_selected(camera_id, rule_config.get("camera_id") or rule_config.get("camera_ids")):
                        await _dispatch(rule_config, event_info)
                if not signal_rules:
                    await local_core.publish("signal_loss", event_info)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Signal watchdog failed: %s", exc)
        await asyncio.sleep(30)


if __name__ == "__main__":
    asyncio.run(process_mqtt_events())


