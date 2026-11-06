"""Reachability checks shared by /system/health and the live snapshot."""

from __future__ import annotations

import asyncio
import socket
import time
from typing import Any

import httpx
from sqlalchemy import select

from api.config import settings

_CACHED_STATUS: dict[str, Any] | None = None
_CACHED_TIME: float = 0.0
_CACHE_TTL: float = 4.0
_PROBE_LOCK = asyncio.Lock()


async def dependency_status(db=None) -> dict[str, Any]:
    global _CACHED_STATUS, _CACHED_TIME
    now = time.monotonic()
    if _CACHED_STATUS is not None and (now - _CACHED_TIME) < _CACHE_TTL:
        return dict(_CACHED_STATUS)

    async with _PROBE_LOCK:
        now = time.monotonic()
        if _CACHED_STATUS is not None and (now - _CACHED_TIME) < _CACHE_TTL:
            return dict(_CACHED_STATUS)

        async def _check_db() -> bool:
            try:
                if db is not None:
                    await asyncio.wait_for(db.execute(select(1)), timeout=0.8)
                    return True
                from api.database import async_session_maker
                async with async_session_maker() as session:
                    await asyncio.wait_for(session.execute(select(1)), timeout=0.8)
                    return True
            except Exception:
                return False

        def _tcp_open(host: str, port: int) -> bool:
            try:
                if not host or not port:
                    return False
                with socket.create_connection((str(host), int(port)), timeout=0.5):
                    return True
            except Exception:
                return False

        async def _check_mqtt() -> bool:
            try:
                broker = getattr(settings, "mqtt_broker", "127.0.0.1") or "127.0.0.1"
                port_val = getattr(settings, "mqtt_port", 1883)
                port = int(port_val) if port_val else 1883
                return await asyncio.to_thread(_tcp_open, broker, port)
            except Exception:
                return False

        async def _check_go2rtc() -> bool:
            try:
                url = (getattr(settings, "go2rtc_url", "") or "").rstrip("/")
                if not url:
                    return False
                async with httpx.AsyncClient(timeout=0.6) as client:
                    response = await client.get(f"{url}/api/streams")
                    return response.status_code == 200
            except Exception:
                return False

        db_task = _check_db()
        mqtt_task = _check_mqtt()
        go2rtc_task = _check_go2rtc()

        results = await asyncio.gather(db_task, mqtt_task, go2rtc_task, return_exceptions=True)
        db_ok = bool(results[0]) if not isinstance(results[0], Exception) else False
        mqtt_ok = bool(results[1]) if not isinstance(results[1], Exception) else False
        go2rtc_ok = bool(results[2]) if not isinstance(results[2], Exception) else False

        healthy = db_ok and (mqtt_ok or go2rtc_ok)
        status = {
            "status": "online" if healthy else "degraded",
            "database_connected": db_ok,
            "mqtt_connected": mqtt_ok,
            "go2rtc_active": go2rtc_ok,
            "record_codec": getattr(settings, "record_video_codec", "copy"),
        }
        _CACHED_STATUS = status
        _CACHED_TIME = now
        return dict(status)
