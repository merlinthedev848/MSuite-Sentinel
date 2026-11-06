"""Stills from the camera's own picture API.

A browser tile that waits on the RTSP feed does not get a picture until the
next IDR. These Hikvision cameras space those about five seconds apart, and
ffmpeg's default probe waits that long as well. The ISAPI picture endpoint
returns a JPEG without waiting for that interval.
"""

from __future__ import annotations

import asyncio
import time
from urllib.parse import urlsplit

import httpx

_CHANNEL_MARK = "channels/"
_PICTURE_MISS: dict[str, float] = {}
_JPEG_CACHE: dict[str, tuple[float, bytes]] = {}
_LOCKS: dict[str, asyncio.Lock] = {}
_KEYFRAME_AT: dict[str, float] = {}


def _host_user_pass(rtsp_url: str | None) -> tuple[str, str, str] | None:
    if not rtsp_url:
        return None
    parts = urlsplit(rtsp_url)
    host = parts.hostname
    if not host:
        return None
    return host, parts.username or "", parts.password or ""


def stream_channel(rtsp_url: str | None) -> str:
    """Hikvision channel id from an RTSP path. Substreams are usually 102."""
    if not rtsp_url:
        return "102"
    lower = rtsp_url.lower()
    mark = lower.find(_CHANNEL_MARK)
    if mark < 0:
        return "102"
    digits = []
    for char in rtsp_url[mark + len(_CHANNEL_MARK):]:
        if char.isdigit():
            digits.append(char)
        else:
            break
    return "".join(digits) or "102"


def picture_urls(rtsp_url: str | None) -> list[str]:
    """HTTP picture URLs for the host stored on the camera. No userinfo."""
    parsed = _host_user_pass(rtsp_url)
    if not parsed:
        return []
    host, _user, _password = parsed
    channel = stream_channel(rtsp_url)
    urls = [f"http://{host}/ISAPI/Streaming/channels/{channel}/picture"]
    other = "101" if channel != "101" else "102"
    urls.append(f"http://{host}/ISAPI/Streaming/channels/{other}/picture")
    return urls


def keyframe_url(rtsp_url: str | None) -> str | None:
    parsed = _host_user_pass(rtsp_url)
    if not parsed:
        return None
    host = parsed[0]
    return f"http://{host}/ISAPI/Streaming/channels/{stream_channel(rtsp_url)}/requestKeyFrame"


def _credentials(rtsp_url: str | None, username: str | None, password: str | None) -> tuple[str, str]:
    parsed = _host_user_pass(rtsp_url)
    user = (parsed[1] if parsed else "") or (username or "")
    secret = (parsed[2] if parsed else "") or (password or "")
    return user, secret


def _is_jpeg(blob: bytes | None) -> bool:
    return bool(blob) and len(blob) > 32 and blob.startswith(b"\xff\xd8")


async def request_keyframe(rtsp_url: str | None, username: str | None = None, password: str | None = None) -> None:
    """Ask the camera to emit an IDR now so the live player does not sit out the GOP.
    Fires concurrently across Hikvision ISAPI, Dahua CGI, and ONVIF SetSynchronizationPoint.
    """
    if not rtsp_url:
        return
    parsed = _host_user_pass(rtsp_url)
    if not parsed:
        return
    host = parsed[0]
    user, secret = _credentials(rtsp_url, username, password)

    now = time.monotonic()
    if now - _KEYFRAME_AT.get(host, 0.0) < 1.5:
        return
    _KEYFRAME_AT[host] = now

    async def _send_hikvision():
        url = keyframe_url(rtsp_url)
        if not url:
            return
        auth = httpx.DigestAuth(user, secret) if user else None
        body = (
            b'<?xml version="1.0" encoding="UTF-8"?>'
            b'<RequestKeyFrame version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"/>'
        )
        try:
            async with httpx.AsyncClient(timeout=0.8, follow_redirects=False) as client:
                await client.put(url, auth=auth, content=body, headers={"Content-Type": "application/xml"})
        except Exception:
            pass

    async def _send_dahua():
        auth = httpx.DigestAuth(user, secret) if user else None
        url = f"http://{host}/cgi-bin/configManager.cgi?action=setConfig&Encode[0].MainFormat[0].Video.KeyFrameInterval=1"
        try:
            async with httpx.AsyncClient(timeout=0.8, follow_redirects=False) as client:
                await client.get(url, auth=auth)
        except Exception:
            pass

    async def _send_onvif():
        from api.services.onvif_service import request_onvif_keyframe
        for port in (80, 8000, 8080, 8899):
            try:
                if await request_onvif_keyframe(host, port=port, username=user, password=secret):
                    break
            except Exception:
                pass

    await asyncio.gather(_send_hikvision(), _send_dahua(), _send_onvif(), return_exceptions=True)


async def fetch_camera_jpeg(
    rtsp_url: str | None,
    username: str | None = None,
    password: str | None = None,
    timeout: float = 0.8,
) -> bytes | None:
    """One JPEG from the camera picture API. None when that API is not there."""
    urls = picture_urls(rtsp_url)
    if not urls:
        return None
    host = _host_user_pass(rtsp_url)[0]
    if time.monotonic() - _PICTURE_MISS.get(host, 0.0) < 15.0:
        return None
    user, secret = _credentials(rtsp_url, username, password)
    digest = httpx.DigestAuth(user, secret) if user else None
    basic = (user, secret) if user else None
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            for url in urls:
                blob = await _get_jpeg(client, url, digest, basic)
                if blob:
                    _PICTURE_MISS.pop(host, None)
                    return blob
    except Exception:
        pass
    _PICTURE_MISS[host] = time.monotonic()
    return None


async def _get_jpeg(client: httpx.AsyncClient, url: str, digest, basic) -> bytes | None:
    try:
        response = await client.get(url, auth=digest)
    except Exception:
        return None
    if response.status_code == 401 and basic is not None:
        try:
            response = await client.get(url, auth=basic)
        except Exception:
            return None
    if response.status_code == 200 and _is_jpeg(response.content):
        return response.content
    return None


async def cached_camera_jpeg(
    camera_id: str,
    rtsp_url: str | None,
    username: str | None = None,
    password: str | None = None,
) -> bytes | None:
    """Share one picture across the event rows that have no stored frame."""
    now = time.monotonic()
    cached = _JPEG_CACHE.get(camera_id)
    if cached and now - cached[0] < 2.0:
        return cached[1]
    if len(_JPEG_CACHE) > 200:
        stale_keys = [k for k, v in _JPEG_CACHE.items() if now - v[0] >= 30.0]
        for k in stale_keys:
            _JPEG_CACHE.pop(k, None)
    if len(_LOCKS) > 200:
        unlocked = [k for k, v in _LOCKS.items() if not v.locked()]
        for k in unlocked:
            _LOCKS.pop(k, None)
    lock = _LOCKS.setdefault(camera_id, asyncio.Lock())
    async with lock:
        cached = _JPEG_CACHE.get(camera_id)
        if cached and time.monotonic() - cached[0] < 2.0:
            return cached[1]
        blob = await fetch_camera_jpeg(rtsp_url, username, password)
        if blob:
            _JPEG_CACHE[camera_id] = (time.monotonic(), blob)
        return blob
