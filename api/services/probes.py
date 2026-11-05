"""Reachability checks shared by /system/health and the live snapshot."""

from __future__ import annotations

import asyncio
import socket

import httpx
from sqlalchemy import select

from api.config import settings


async def dependency_status(db=None) -> dict:
    db_ok = False
    try:
        if db is not None:
            await db.execute(select(1))
            db_ok = True
        else:
            from api.database import async_session_maker
            async with async_session_maker() as session:
                await session.execute(select(1))
                db_ok = True
    except Exception:
        db_ok = False

    def _tcp_open(host: str, port: int) -> bool:
        try:
            if not host or not port:
                return False
            with socket.create_connection((str(host), int(port)), timeout=1.5):
                return True
        except Exception:
            return False

    mqtt_ok = False
    try:
        broker = getattr(settings, "mqtt_broker", "127.0.0.1") or "127.0.0.1"
        port_val = getattr(settings, "mqtt_port", 1883)
        port = int(port_val) if port_val else 1883
        mqtt_ok = await asyncio.to_thread(_tcp_open, broker, port)
    except Exception:
        mqtt_ok = False

    go2rtc_ok = False
    try:
        url = (getattr(settings, "go2rtc_url", "") or "").rstrip("/")
        if url:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{url}/api/streams")
                go2rtc_ok = response.status_code == 200
    except Exception:
        go2rtc_ok = False

    healthy = db_ok and (mqtt_ok or go2rtc_ok)
    return {
        "status": "online" if healthy else "degraded",
        "database_connected": db_ok,
        "mqtt_connected": mqtt_ok,
        "go2rtc_active": go2rtc_ok,
        "record_codec": getattr(settings, "record_video_codec", "copy"),
    }
