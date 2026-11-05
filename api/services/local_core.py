"""Local appliance core for fast in-process state sharing.

The API remains the browser/mobile boundary, but internal workers should not
need to rediscover runtime state through HTTP calls. This module keeps a small
process-local snapshot and broadcasts changes to connected UI clients.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import time
from datetime import datetime, timezone
from typing import Any

import psutil
from sqlalchemy import desc, select

from api.config import settings
from api.database import async_session_maker
from api.models.ai import SemanticEvent
from api.models.camera import Camera

logger = logging.getLogger("mView-LocalCore")


def _safe_disk_usage(path_str: str) -> tuple[int, int, int]:
    """Safely obtain disk usage for a path, gracefully falling back to existing parent directory or cwd."""
    try:
        p = Path(path_str)
        while True:
            if p.exists():
                try:
                    return shutil.disk_usage(str(p))
                except Exception:
                    pass
            if p == p.parent:
                break
            p = p.parent
    except Exception:
        pass
    for fallback in [Path.cwd(), Path.home(), "."]:
        try:
            return shutil.disk_usage(str(fallback))
        except Exception:
            pass
    return (0, 0, 0)


class LocalCore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._last_network: dict[str, float] | None = None
        self._last_storage_refresh = 0.0
        try:
            initial_health = self._health_payload()
        except Exception:
            initial_health = None
        self._snapshot: dict[str, Any] = {
            "type": "snapshot",
            "cameras": [],
            "events": [],
            "health": initial_health,
            "recording": {},
            "recording_storage": None,
            "stream_diagnostics": {},
            "updated_at": datetime.now(timezone.utc).isoformat() if initial_health else None,
        }

    async def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        event = {
            "type": event_type,
            "payload": payload,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        async with self._lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    async def update_snapshot(self, **values: Any) -> dict[str, Any]:
        async with self._lock:
            self._snapshot.update(values)
            self._snapshot["updated_at"] = datetime.now(timezone.utc).isoformat()
            snapshot = dict(self._snapshot)
        await self.publish("snapshot", snapshot)
        return snapshot

    async def get_snapshot(self) -> dict[str, Any]:
        async with self._lock:
            return dict(self._snapshot)

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10)
        async with self._lock:
            self._subscribers.add(queue)
            snapshot = dict(self._snapshot)
        if snapshot.get("health") is None:
            try:
                snapshot["health"] = self._health_payload()
            except Exception:
                pass
            asyncio.create_task(self.refresh_snapshot(include_storage=True))
        queue.put_nowait({"type": "snapshot", "payload": snapshot})
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    async def refresh_snapshot(self, *, include_storage: bool = False) -> dict[str, Any]:
        from api.services.recorder import recorder_manager, storage_report

        async with async_session_maker() as db:
            cameras_result = await db.execute(select(Camera))
            cameras = [_camera_payload(camera) for camera in cameras_result.scalars().all()]

            events_result = await db.execute(
                select(SemanticEvent).order_by(desc(SemanticEvent.timestamp)).limit(20)
            )
            events = [_event_payload(event) for event in events_result.scalars().all()]

        health = await asyncio.to_thread(self._health_payload)
        try:
            from api.services.probes import dependency_status
            health.update(await dependency_status())
            health.setdefault("network", {})
            health["network"]["ok"] = health.get("status") == "online"
        except Exception as exc:
            logger.warning("Dependency probe failed: %s", exc)
            health["status"] = "degraded"
        recording_storage = None
        now = time.monotonic()
        if include_storage or now - self._last_storage_refresh > 60:
            recording_storage = await asyncio.to_thread(storage_report)
            self._last_storage_refresh = now
        else:
            recording_storage = (await self.get_snapshot()).get("recording_storage")

        return await self.update_snapshot(
            cameras=cameras,
            events=events,
            health=health,
            recording=recorder_manager.status(),
            stream_diagnostics=recorder_manager.diagnostics(),
            recording_storage=recording_storage,
        )

    def _health_payload(self) -> dict[str, Any]:
        started = time.monotonic()
        cpu_percent = psutil.cpu_percent(interval=None)
        memory = psutil.virtual_memory()
        net = psutil.net_io_counters()
        storage_path = settings.storage_path
        total, used, free = _safe_disk_usage(storage_path)

        now = time.monotonic()
        up_mbps = 0.0
        down_mbps = 0.0
        if self._last_network:
            elapsed = max(now - self._last_network["timestamp"], 1)
            up_mbps = max(0, ((net.bytes_sent - self._last_network["sent"]) * 8) / elapsed / 1_000_000)
            down_mbps = max(0, ((net.bytes_recv - self._last_network["recv"]) * 8) / elapsed / 1_000_000)
        self._last_network = {"sent": net.bytes_sent, "recv": net.bytes_recv, "timestamp": now}

        return {
            "status": "online",
            "cpu_usage_percent": cpu_percent,
            "memory_usage_percent": memory.percent,
            "memory_total_gb": round(memory.total / (1024**3), 2),
            "network": {
                "bytes_sent": net.bytes_sent,
                "bytes_recv": net.bytes_recv,
                "up_mbps": round(up_mbps, 2),
                "down_mbps": round(down_mbps, 2),
            },
            "storage": {
                "path": storage_path,
                "total_gb": round(total / (1024**3), 2),
                "used_gb": round(used / (1024**3), 2),
                "free_gb": round(free / (1024**3), 2),
                "usage_percent": round((used / total) * 100, 2) if total > 0 else 0,
            },
            "record_codec": getattr(settings, "record_codec", "copy"),
            "latency_ms": round((time.monotonic() - started) * 1000),
        }


async def local_snapshot_worker() -> None:
    logger.info("Starting local core snapshot worker...")
    await local_core.refresh_snapshot(include_storage=True)
    while True:
        try:
            await local_core.refresh_snapshot()
        except asyncio.CancelledError:
            logger.info("Local core snapshot worker cancelled.")
            raise
        except Exception as e:
            logger.error("Local core snapshot refresh failed: %s", e)
        await asyncio.sleep(10)


def sse_pack(event: dict[str, Any]) -> str:
    event_type = event.get("type", "message")
    return f"event: {event_type}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"


def _camera_payload(camera: Camera) -> dict[str, Any]:
    from api.security import mask_rtsp_url
    return {
        "id": camera.id,
        "name": camera.name,
        "location": camera.location,
        "status": camera.status,
        "enabled": camera.enabled,
        "rtsp_url_main": mask_rtsp_url(camera.rtsp_url_main),
        "rtsp_url_sub": mask_rtsp_url(camera.rtsp_url_sub),
        "manufacturer": camera.manufacturer,
        "model": camera.model,
        "resolution": camera.resolution,
        "onvif_endpoint": camera.onvif_endpoint,
        "config": camera.config or {},
    }


def _event_payload(event: SemanticEvent) -> dict[str, Any]:
    return {
        "id": str(event.id),
        "camera_id": event.camera_id,
        "object_class": event.object_class,
        "confidence": event.confidence,
        "timestamp": event.timestamp.isoformat() if event.timestamp else None,
    }


local_core = LocalCore()

