import asyncio
import logging
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from api.config import settings
from api.database import get_db, async_session_maker
from api.models.camera import Camera
from api.schemas.camera import CameraResponse, CameraCreate, CameraUpdate, ONVIFDiscoveryResult
from api.services.onvif_service import onvif_service
from api.services.recorder import recorder_manager
from api.services.local_core import local_core
from api.security import can_view_secrets, is_masked_rtsp, is_masked_secret, mask_rtsp_url, mask_secret

log = logging.getLogger("sentinel.cameras")

router = APIRouter(prefix="/cameras", tags=["Cameras"])


def _require_settings(request: Request) -> None:
    user = getattr(request.state, "user", None) or {}
    if user.get("role") == "admin" or "settings" in set(user.get("permissions") or []):
        return
    raise HTTPException(403, "Settings permission required")


def _present_camera(cam: Camera, user: dict | None, rec_status: dict | None = None) -> dict:
    from api.services.recorder import recorder_manager
    if rec_status is None:
        rec_status = recorder_manager.status()
    rec_state = rec_status.get(cam.id)
    payload = CameraResponse.model_validate(cam).model_dump(mode="json")
    if not cam.enabled:
        payload["status"] = "disabled"
    elif rec_state == "recording":
        payload["status"] = "online"
    elif rec_state in ("backoff", "error"):
        payload["status"] = "offline"

    if can_view_secrets(user):
        return payload
    payload["onvif_password"] = mask_secret(payload.get("onvif_password"))
    payload["rtsp_url_main"] = mask_rtsp_url(payload.get("rtsp_url_main"))
    payload["rtsp_url_sub"] = mask_rtsp_url(payload.get("rtsp_url_sub"))
    return payload


def _ignore_masked_updates(data: dict) -> dict:
    pwd = data.get("onvif_password")
    if pwd is None or pwd == "" or is_masked_secret(pwd):
        data.pop("onvif_password", None)
    user = data.get("onvif_username")
    if user is None or user == "":
        data.pop("onvif_username", None)
    for key in ("rtsp_url_main", "rtsp_url_sub"):
        val = data.get(key)
        if val is None or val == "" or is_masked_rtsp(val):
            data.pop(key, None)
    return data


async def _refresh_recorder() -> None:
    async with async_session_maker() as session:
        result = await session.execute(select(Camera))
        cams = result.scalars().all()
    await recorder_manager.sync_cameras(cams)
    await local_core.refresh_snapshot()


class PTZMove(BaseModel):
    action: str = Field(pattern="^(up|down|left|right|zoom_in|zoom_out)$")
    speed: float = Field(default=0.5, ge=0.0, le=1.0)


@router.get("", response_model=List[CameraResponse])
async def get_cameras(request: Request, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera))
    cams = result.scalars().all()
    
    # Inject active recording status dynamically
    recording_ids = recorder_manager.status()
    user = getattr(request.state, "user", None)
    presented = []
    for cam in cams:
        if cam.id in recording_ids and recording_ids[cam.id] == "recording":
            cam.status = "recording"
        presented.append(_present_camera(cam, user))
    return presented


@router.post("", response_model=CameraResponse, status_code=201)
async def create_camera(request: Request, camera: CameraCreate, db: AsyncSession = Depends(get_db)):
    _require_settings(request)
    data = camera.model_dump()
    new_cam = Camera(**data)
    try:
        db.add(new_cam)
        await db.commit()
        await db.refresh(new_cam)
    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"Database creation failed: {e}")
    await _refresh_recorder()
    return _present_camera(new_cam, getattr(request.state, "user", None))


@router.patch("/{camera_id}", response_model=CameraResponse)
async def update_camera(camera_id: str, update: CameraUpdate, request: Request, db: AsyncSession = Depends(get_db)):
    _require_settings(request)
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")
    try:
        for k, v in _ignore_masked_updates(update.model_dump(exclude_unset=True)).items():
            setattr(cam, k, v)
        await db.commit()
        await db.refresh(cam)
    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"Database update failed: {e}")
    await _refresh_recorder()
    return _present_camera(cam, getattr(request.state, "user", None))


@router.delete("/{camera_id}")
async def delete_camera(camera_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    _require_settings(request)
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")
    
    # Cascade delete associated events and reviews in safe subquery
    from sqlalchemy import delete
    from api.models.ai import SemanticEvent
    from api.models.operations import EventReview
    try:
        subquery = select(SemanticEvent.id).where(SemanticEvent.camera_id == camera_id)
        await db.execute(delete(EventReview).where(EventReview.event_id.in_(subquery)))
        await db.execute(delete(SemanticEvent).where(SemanticEvent.camera_id == camera_id))
        await db.execute(delete(Camera).where(Camera.id == camera_id))
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"Database deletion failed: {e}")

    # Cancel active PTZ tour if running
    if camera_id in _active_tours:
        _active_tours[camera_id].cancel()
        _active_tours.pop(camera_id, None)

    # Purge video recording files and stop active streams
    from api.services.recorder import purge_all_recordings
    await asyncio.to_thread(purge_all_recordings, camera_id)
    await _refresh_recorder()
    return {"status": "deleted"}


@router.post("/{camera_id}/ensure-stream")
async def ensure_stream(camera_id: str, quality: str = "auto", db: AsyncSession = Depends(get_db)):
    """Register this camera with go2rtc before the player connects.

    The UI used to guess a stream name and start WebRTC immediately. If registration
    was still retrying, or the name did not match, the player had nothing to show.
    """
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")
    if not cam.rtsp_url_main and not cam.rtsp_url_sub:
        raise HTTPException(400, "Camera has no RTSP stream configured")

    from api.services.camera_picture import request_keyframe
    from api.services.recorder import register_go2rtc_stream

    # The recorder already keeps `cam.id` open on the substream. Opening the
    # main stream as well, just because the dashboard loaded, makes the camera
    # spend the next several seconds bringing up another RTSP session.
    if quality == "main" and cam.rtsp_url_main:
        src, stream_url = f"{cam.id}_main", cam.rtsp_url_main
        audio_url = cam.rtsp_url_main
    else:
        src, stream_url = cam.id, (cam.rtsp_url_sub or cam.rtsp_url_main)
        audio_url = cam.rtsp_url_main or cam.rtsp_url_sub
    registered = await register_go2rtc_stream(src, stream_url, attempts=1, timeout=1.5, audio_source_url=audio_url)
    asyncio.create_task(request_keyframe(stream_url, cam.onvif_username, cam.onvif_password))
    return {"src": src, "streams": [src], "registered": bool(registered)}


@router.get("/{camera_id}/snapshot")
async def get_camera_snapshot(camera_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    rtsp_url = cam.rtsp_url_sub or cam.rtsp_url_main
    if not rtsp_url:
        raise HTTPException(400, "Camera has no RTSP stream configured")

    from api.services.camera_picture import fetch_camera_jpeg

    # One keyframe is requested when the stream is registered. Requesting one
    # on every still resets the GOP and the tile blinks.
    jpeg = await fetch_camera_jpeg(rtsp_url, cam.onvif_username, cam.onvif_password)
    if jpeg:
        return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    # Already-open go2rtc stream using pooled HTTP client.
    try:
        client = getattr(request.app.state, "http_client", None)
        if client is not None:
            resp = await client.get(
                f"{settings.go2rtc_url.rstrip('/')}/api/frame.jpeg",
                params={"src": camera_id},
                timeout=1.5,
            )
        else:
            async with httpx.AsyncClient(timeout=1.5) as client_fallback:
                resp = await client_fallback.get(
                    f"{settings.go2rtc_url.rstrip('/')}/api/frame.jpeg",
                    params={"src": camera_id},
                )
        if resp.status_code == 200 and resp.content.startswith(b"\xff\xd8") and len(resp.content) > 32:
            return Response(content=resp.content, media_type="image/jpeg", headers={"Cache-Control": "no-store"})
    except Exception:
        pass
    raise HTTPException(502, "Snapshot capture failed")


@router.post("/{camera_id}/ptz/move")
async def move_camera_ptz(camera_id: str, command: PTZMove, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")
    if not cam.onvif_endpoint:
        raise HTTPException(400, "Camera has no ONVIF endpoint configured")

    ok = await asyncio.to_thread(
        onvif_service.move_ptz,
        cam.onvif_endpoint,
        cam.onvif_username or "",
        cam.onvif_password or "",
        command.action,
        command.speed,
    )
    if not ok:
        raise HTTPException(502, "PTZ move command failed")
    return {"status": "moving", "action": command.action}


@router.post("/{camera_id}/ptz/stop")
async def stop_camera_ptz(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")
    if not cam.onvif_endpoint:
        raise HTTPException(400, "Camera has no ONVIF endpoint configured")

    ok = await asyncio.to_thread(
        onvif_service.stop_ptz,
        cam.onvif_endpoint,
        cam.onvif_username or "",
        cam.onvif_password or "",
    )
    if not ok:
        raise HTTPException(502, "PTZ stop command failed")
    return {"status": "stopped"}


class PTZPresetRequest(BaseModel):
    name: str

class PTZTourRequest(BaseModel):
    enabled: bool
    interval_seconds: int = 15

_active_tours: dict[str, asyncio.Task] = {}


async def _run_camera_tour(camera_id: str, interval: int):
    try:
        while True:
            from api.database import async_session_maker
            async with async_session_maker() as session:
                cam = await session.get(Camera, camera_id)
                if not cam or not (cam.config or {}).get("ptz", {}).get("tour_enabled"):
                    break
                presets = (cam.config or {}).get("ptz", {}).get("presets", [])
                onvif_ep = cam.onvif_endpoint
                onvif_user = cam.onvif_username or ""
                onvif_pass = cam.onvif_password or ""
                if not presets or not onvif_ep:
                    break

            for preset in presets:
                preset_name = preset if isinstance(preset, str) else preset.get("name")
                if preset_name and onvif_ep:
                    await asyncio.to_thread(
                        onvif_service.goto_preset,
                        onvif_ep,
                        onvif_user,
                        onvif_pass,
                        preset_name,
                    )
                await asyncio.sleep(interval)
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        import logging
        logging.getLogger("sentinel.ptz").warning("PTZ tour error for camera %s: %s", camera_id, exc)
    finally:
        _active_tours.pop(camera_id, None)


@router.get("/{camera_id}/ptz/presets")
async def get_ptz_presets(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    config = cam.config or {}
    ptz_config = config.get("ptz", {})
    presets = list(ptz_config.get("presets", ["Home Gate", "Driveway", "Front Yard"]))

    # Synchronize with hardware presets if onvif is connected
    if cam.onvif_endpoint:
        hw_presets = await asyncio.to_thread(
            onvif_service.get_presets,
            cam.onvif_endpoint,
            cam.onvif_username or "",
            cam.onvif_password or "",
        )
        for hw in hw_presets:
            hw_name = hw.get("name")
            if hw_name and hw_name not in presets:
                presets.append(hw_name)

    return {"presets": presets}


@router.post("/{camera_id}/ptz/presets")
async def save_ptz_preset(camera_id: str, req: PTZPresetRequest, request: Request, db: AsyncSession = Depends(get_db)):
    _require_settings(request)
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    preset_name = req.name.strip()
    if not preset_name:
        raise HTTPException(400, "Preset name cannot be empty")

    token = None
    if cam.onvif_endpoint:
        token = await asyncio.to_thread(
            onvif_service.set_preset,
            cam.onvif_endpoint,
            cam.onvif_username or "",
            cam.onvif_password or "",
            preset_name,
        )

    config = dict(cam.config or {})
    ptz_config = dict(config.get("ptz", {}))
    presets = list(ptz_config.get("presets", ["Home Gate", "Driveway", "Front Yard"]))
    if preset_name not in presets:
        presets.append(preset_name)
    ptz_config["presets"] = presets
    config["ptz"] = ptz_config
    cam.config = config
    await db.commit()
    return {"status": "success", "presets": presets, "token": token}


@router.post("/{camera_id}/ptz/goto")
async def goto_ptz_preset(camera_id: str, req: PTZPresetRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    preset_name = req.name.strip()
    if not preset_name:
        raise HTTPException(400, "Preset target cannot be empty")

    if not cam.onvif_endpoint:
        raise HTTPException(400, "Camera has no ONVIF endpoint configured")

    ok = await asyncio.to_thread(
        onvif_service.goto_preset,
        cam.onvif_endpoint,
        cam.onvif_username or "",
        cam.onvif_password or "",
        preset_name,
    )
    if not ok:
        raise HTTPException(502, f"Failed to drive camera to preset '{preset_name}'")

    return {"status": "moved", "target": preset_name}


@router.post("/{camera_id}/ptz/tour")
async def toggle_ptz_tour(camera_id: str, req: PTZTourRequest, request: Request, db: AsyncSession = Depends(get_db)):
    _require_settings(request)
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    config = dict(cam.config or {})
    ptz_config = dict(config.get("ptz", {}))
    ptz_config["tour_enabled"] = req.enabled
    ptz_config["tour_interval"] = req.interval_seconds
    config["ptz"] = ptz_config
    cam.config = config
    await db.commit()

    if req.enabled:
        if camera_id in _active_tours:
            _active_tours[camera_id].cancel()
        _active_tours[camera_id] = asyncio.create_task(
            _run_camera_tour(camera_id, req.interval_seconds),
            name=f"ptz-tour-{camera_id}"
        )
    else:
        if camera_id in _active_tours:
            _active_tours[camera_id].cancel()
            _active_tours.pop(camera_id, None)

    return {"status": "tour_updated", "enabled": req.enabled, "interval": req.interval_seconds}




@router.post("/discover", response_model=List[ONVIFDiscoveryResult])
async def discover_cameras(request: Request):
    """Scan network for ONVIF cameras (WS-Discovery + IP range scan fallback)."""
    _require_settings(request)
    try:
        return await onvif_service.discover_cameras(timeout=4)
    except Exception as e:
        raise HTTPException(500, f"Discovery failed: {e}")


def get_default_rtsp_paths(manufacturer: str | None, model: str | None, ip: str, username: str, password: str) -> tuple[str, str | None]:
    import urllib.parse
    m = (manufacturer or "").lower()
    enc_user = urllib.parse.quote(username, safe="") if username else ""
    enc_pass = urllib.parse.quote(password, safe="") if password else ""
    creds = f"{enc_user}:{enc_pass}@" if enc_user else ""
    
    if "hikvision" in m or "hik" in m:
        return (
            f"rtsp://{creds}{ip}:554/Streaming/Channels/101",
            f"rtsp://{creds}{ip}:554/Streaming/Channels/102"
        )
    elif "dahua" in m or "amcrest" in m or "lts" in m:
        return (
            f"rtsp://{creds}{ip}:554/cam/realmonitor?channel=1&subtype=0",
            f"rtsp://{creds}{ip}:554/cam/realmonitor?channel=1&subtype=1"
        )
    elif "reolink" in m:
        return (
            f"rtsp://{creds}{ip}:554/h264Preview_01_main",
            f"rtsp://{creds}{ip}:554/h264Preview_01_sub"
        )
    elif "axis" in m:
        return (
            f"rtsp://{creds}{ip}:554/axis-media/media.amp",
            None
        )
    elif "foscam" in m:
        return (
            f"rtsp://{creds}{ip}:554/videoMain",
            f"rtsp://{creds}{ip}:554/videoSub"
        )
    else:
        # Generic fallback
        return (
            f"rtsp://{creds}{ip}:554/stream1",
            f"rtsp://{creds}{ip}:554/stream2"
        )


class AdoptCameraRequest(ONVIFDiscoveryResult):
    username: str = ""
    password: str = ""
    name: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


@router.post("/adopt", response_model=CameraResponse, status_code=201)
async def adopt_camera(
    data: AdoptCameraRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Probe a discovered device for RTSP streams, then save it."""
    _require_settings(request)
    username = data.username or ""
    password = data.password or ""
    import urllib.parse
    port = 80
    ip = (data.ip or "").strip()
    if data.onvif_endpoint:
        try:
            parsed = urllib.parse.urlparse(data.onvif_endpoint)
            if parsed.port:
                port = parsed.port
            if not ip and parsed.hostname:
                ip = parsed.hostname
        except Exception:
            pass

    if not ip:
        raise HTTPException(400, "Camera IP address or valid ONVIF endpoint is required")

    streams = None
    try:
        streams = await asyncio.wait_for(
            asyncio.to_thread(
                onvif_service.get_camera_streams,
                ip, port, username, password
            ),
            timeout=4.0
        )
    except Exception as e:
        log.warning("ONVIF stream probe timed out or failed for %s:%s: %s", ip, port, e)

    def inject_rtsp_credentials(rtsp_url: str | None, user: str, psw: str) -> str | None:
        if not rtsp_url or not user:
            return rtsp_url
        import urllib.parse
        parsed = urllib.parse.urlsplit(rtsp_url)
        if parsed.username or "@" in (parsed.netloc or ""):
            return rtsp_url
        scheme = parsed.scheme or "rtsp"
        enc_user = urllib.parse.quote(user, safe="")
        enc_pass = urllib.parse.quote(psw, safe="")
        host_port = parsed.netloc or parsed.path
        path = parsed.path if parsed.netloc else ""
        netloc = f"{enc_user}:{enc_pass}@{host_port}"
        return urllib.parse.urlunsplit((scheme, netloc, path, parsed.query, parsed.fragment))

    if streams:
        rtsp_main = inject_rtsp_credentials(streams[0].get("rtsp_url"), username, password)
        rtsp_sub  = inject_rtsp_credentials(streams[1].get("rtsp_url"), username, password) if len(streams) > 1 else None
        resolution = streams[0].get("resolution")
    else:
        # Fall back to manufacturer-specific defaults
        rtsp_main, rtsp_sub = get_default_rtsp_paths(
            data.manufacturer, data.model, ip, username, password
        )
        resolution = None

    cam_name = data.name.strip() if data.name and data.name.strip() else f"{data.manufacturer} {data.model} ({ip})"
    cam = Camera(
        name=cam_name,
        rtsp_url_main=rtsp_main,
        rtsp_url_sub=rtsp_sub,
        onvif_endpoint=data.onvif_endpoint or f"http://{ip}:{port}/onvif/device_service",
        onvif_username=username,
        onvif_password=password,
        manufacturer=data.manufacturer or "Generic",
        model=data.model or "IP Camera",
        resolution=resolution,
        status="online",
        auto_adopted=True,
    )
    try:
        db.add(cam)
        await db.commit()
        await db.refresh(cam)
    except Exception as e:
        await db.rollback()
        raise HTTPException(500, f"Database adoption failed: {e}")
    await _refresh_recorder()
    return _present_camera(cam, getattr(request.state, "user", None))
