"""Play footage the camera stored itself when the recorder has a gap.

Detections can exist for a time the NVR never wrote a file. Hikvision keeps
that picture on the camera SD card and serves it as an RTSP playback track.
Search results that leave this process contain only start, end, and track.
The RTSP URL, including the password, stays on the server.
"""

from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlsplit

import httpx

from api.services.camera_picture import _credentials, _host_user_pass, stream_channel

_MAX_PIECE_SECONDS = 600
_SEARCH_TIMEOUT = 8.0
_PAGE = 40
_MAX_PAGES = 12


def hik_clock(moment: datetime) -> str:
    """Hikvision playback clock. The trailing Z is part of their format."""
    moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y%m%dT%H%M%SZ")


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(node: ET.Element, name: str) -> ET.Element | None:
    for child in list(node):
        if _local(child.tag) == name:
            return child
    return None


def _text(node: ET.Element | None, name: str) -> str:
    if node is None:
        return ""
    child = _child(node, name)
    return (child.text or "").strip() if child is not None else ""


def _parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def search_body(track: str, start: datetime, end: datetime, position: int, search_id: str) -> bytes:
    start_text = _iso(start)
    end_text = _iso(end)
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<CMSearchDescription>"
        f"<searchID>{search_id}</searchID>"
        f"<trackList><trackID>{track}</trackID></trackList>"
        "<timeSpanList><timeSpan>"
        f"<startTime>{start_text}</startTime><endTime>{end_text}</endTime>"
        "</timeSpan></timeSpanList>"
        f"<maxResults>{_PAGE}</maxResults>"
        f"<searchResultPostion>{position}</searchResultPostion>"
        "<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>"
        "</CMSearchDescription>"
    )
    return xml.encode()


def parse_search_matches(payload: bytes, host: str) -> list[tuple[datetime, datetime, str]]:
    """Time spans from one search page. A playback URI for any other host is ignored."""
    if not payload:
        return []
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        return []
    spans: list[tuple[datetime, datetime, str]] = []
    for item in root.iter():
        if _local(item.tag) != "searchMatchItem":
            continue
        window = _child(item, "timeSpan")
        start = _parse_time(_text(window, "startTime"))
        end = _parse_time(_text(window, "endTime"))
        if start is None or end is None or end <= start:
            continue
        track = _text(item, "trackID") or "101"
        media = _child(item, "mediaSegmentDescriptor")
        playback = _text(media, "playbackURI")
        if playback:
            target = urlsplit(playback)
            if target.hostname and target.hostname != host:
                continue
            path = target.path or ""
            mark = path.rfind("/")
            if mark >= 0 and path[mark + 1:].isdigit():
                track = path[mark + 1:]
        if not track.isdigit():
            track = "101"
        spans.append((start, end, track))
    return spans


def _merge(spans: list[tuple[datetime, datetime]], gap_seconds: float = 2) -> list[tuple[datetime, datetime]]:
    ordered = sorted(spans)
    merged: list[tuple[datetime, datetime]] = []
    for start, end in ordered:
        if merged and (start - merged[-1][1]).total_seconds() <= gap_seconds:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _subtract(start: datetime, end: datetime, covered: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    cursor = start
    pieces: list[tuple[datetime, datetime]] = []
    for cover_start, cover_end in sorted(covered):
        left = max(cover_start, start)
        right = min(cover_end, end)
        if right <= left:
            continue
        if left > cursor:
            pieces.append((cursor, left))
        cursor = max(cursor, right)
    if cursor < end:
        pieces.append((cursor, end))
    return [(s, e) for s, e in pieces if (e - s).total_seconds() >= 1]


def coalesce_spans(items: list[tuple[datetime, datetime, str]]) -> list[dict]:
    """One track's footage, cut where the other track already covers, in pieces a player can open."""
    grouped: dict[str, list[tuple[datetime, datetime]]] = {}
    for start, end, track in items:
        grouped.setdefault(track, []).append((start, end))
    primary_track = "101" if "101" in grouped else (next(iter(grouped), "101"))
    primary = _merge(grouped.get(primary_track, []))
    pieces: list[tuple[str, datetime, datetime]] = [(primary_track, start, end) for start, end in primary]
    for track, spans in grouped.items():
        if track == primary_track:
            continue
        for start, end in _merge(spans):
            for gap_start, gap_end in _subtract(start, end, primary):
                pieces.append((track, gap_start, gap_end))

    public: list[dict] = []
    for track, start, end in pieces:
        cursor = start
        while (end - cursor).total_seconds() > _MAX_PIECE_SECONDS:
            nxt = cursor + timedelta(seconds=_MAX_PIECE_SECONDS)
            public.append({"start": _iso(cursor), "end": _iso(nxt), "track": track})
            cursor = nxt
        if (end - cursor).total_seconds() >= 1:
            public.append({"start": _iso(cursor), "end": _iso(end), "track": track})
    public.sort(key=lambda item: (item["start"], item["track"]))
    return public


def playback_rtsp(
    rtsp_url: str | None,
    username: str | None,
    password: str | None,
    start: datetime,
    end: datetime,
    track: str,
) -> str | None:
    """RTSP playback URL for the host stored on the camera. None when there is no host."""
    parsed = _host_user_pass(rtsp_url)
    if not parsed:
        return None
    host = parsed[0]
    user, secret = _credentials(rtsp_url, username, password)
    port = urlsplit(rtsp_url or "").port or 554
    if not track.isdigit():
        track = stream_channel(rtsp_url)
    auth = ""
    if user:
        auth = f"{quote(user, safe='')}:{quote(secret, safe='')}@"
    return (
        f"rtsp://{auth}{host}:{port}/Streaming/tracks/{track}"
        f"?starttime={hik_clock(start)}&endtime={hik_clock(end)}"
    )


def _public_has_secret(segments: list[dict]) -> bool:
    blob = " ".join(str(value) for item in segments for value in item.values())
    return "rtsp://" in blob or "://" in blob


async def _post_search(client: httpx.AsyncClient, url: str, body: bytes, digest, basic) -> bytes | None:
    try:
        response = await client.post(url, auth=digest, content=body, headers={"Content-Type": "application/xml"})
    except Exception:
        return None
    if response.status_code == 401 and basic is not None:
        try:
            response = await client.post(url, auth=basic, content=body, headers={"Content-Type": "application/xml"})
        except Exception:
            return None
    if response.status_code != 200 or not response.content:
        return None
    return response.content


async def _search_track(
    client: httpx.AsyncClient,
    host: str,
    user: str,
    secret: str,
    track: str,
    start: datetime,
    end: datetime,
    found: list[tuple[datetime, datetime, str]],
) -> None:
    url = f"http://{host}/ISAPI/ContentMgmt/search"
    digest = httpx.DigestAuth(user, secret) if user else None
    basic = (user, secret) if user else None
    position = 0
    for page in range(_MAX_PAGES):
        body = search_body(track, start, end, position, f"sentinel-{track}-{page}")
        payload = await _post_search(client, url, body, digest, basic)
        if not payload:
            return
        matches = parse_search_matches(payload, host)
        if not matches:
            return
        found.extend(matches)
        if len(matches) < _PAGE:
            return
        position += len(matches)


async def search_camera_footage(
    rtsp_url: str | None,
    username: str | None,
    password: str | None,
    start: datetime,
    end: datetime,
) -> list[dict]:
    """Spans the camera can play. Empty when the camera has no search API or no footage."""
    parsed = _host_user_pass(rtsp_url)
    if not parsed:
        return []
    host, embedded_user, embedded_secret = parsed
    user = embedded_user or (username or "")
    secret = embedded_secret or (password or "")
    channel = stream_channel(rtsp_url)
    tracks = [channel] if channel in ("101", "102") else []
    for track in ("101", "102"):
        if track not in tracks:
            tracks.append(track)
    found: list[tuple[datetime, datetime, str]] = []

    async def run() -> None:
        async with httpx.AsyncClient(timeout=3.5, follow_redirects=False) as client:
            await asyncio.gather(*[
                _search_track(client, host, user, secret, track, start, end, found)
                for track in tracks
            ])

    try:
        await asyncio.wait_for(run(), timeout=_SEARCH_TIMEOUT)
    except (asyncio.TimeoutError, Exception):
        pass
    segments = coalesce_spans(found)
    if _public_has_secret(segments):
        return []
    return segments


async def open_edge_ffmpeg(rtsp_playback: str):
    """ffmpeg process that remuxes one camera playback URL into fMP4 on stdout.

    The URL is not logged. The caller terminates the process.
    """
    return await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-timeout", "8000000",
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-probesize", "32768",
        "-analyzeduration", "0",
        "-i", rtsp_playback,
        "-an",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-profile:v", "baseline",
        "-g", "25",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
