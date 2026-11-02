"""Shared request guards for camera secrets, paths, and outbound webhooks."""

from __future__ import annotations

import ipaddress
import re
import socket
from pathlib import Path
from urllib.parse import urlparse

_RTSP_USERINFO = re.compile(r"(rtsp(?:s)?://)([^/@\s]+)@", re.IGNORECASE)
MASK = "********"


def can_view_secrets(user: dict | None) -> bool:
    if not user:
        return False
    if user.get("role") in ("admin", "settings"):
        return True
    return "settings" in set(user.get("permissions") or [])


def mask_rtsp_url(url: str | None) -> str | None:
    if not url:
        return url
    return _RTSP_USERINFO.sub(r"\1***:***@", url)


def mask_secret(value: str | None) -> str | None:
    if not value:
        return value
    return MASK


def is_masked_secret(value: str | None) -> bool:
    return value in (MASK, "***", "*****")


def is_masked_rtsp(url: str | None) -> bool:
    return bool(url) and "***:***@" in url


def contained_path(root: str | Path, candidate: str | Path) -> Path | None:
    """Resolve ``candidate`` and return it only when it stays inside ``root``."""
    try:
        base = Path(root).resolve()
        path = Path(candidate).resolve()
    except OSError:
        return None
    if path == base or base in path.parents:
        return path
    return None


def safe_camera_id(camera_id: str | None) -> str | None:
    if camera_id is None:
        return None
    text = camera_id.strip()
    if not text or text != Path(text).name or ".." in text or "/" in text or "\\" in text:
        raise ValueError("invalid camera id")
    return text


def webhook_target_allowed(url: str | None) -> bool:
    """Allow public http(s) webhook targets and refuse local or metadata addresses."""
    if not url:
        return False
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    host = parsed.hostname.strip().lower()
    if host in {"localhost", "metadata.google.internal"} or host.endswith(".local"):
        return False
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, parsed.port or 80)}
    except socket.gaierror:
        return False
    if not addresses:
        return False
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False
    return True
