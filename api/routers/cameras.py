import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import List

from api.database import get_db
from api.models.camera import Camera
from api.schemas.camera import CameraResponse, CameraCreate, CameraUpdate, ONVIFDiscoveryResult
from api.services.onvif_service import onvif_service
from api.services.recorder import recorder_manager
from api.services.local_core import local_core

router = APIRouter(prefix="/cameras", tags=["Cameras"])


async def _refresh_recorder(db: AsyncSession):
    result = await db.execute(select(Camera))
    await recorder_manager.sync_cameras(result.scalars().all())
    await local_core.refresh_snapshot()


class PTZMove(BaseModel):
    action: str = Field(pattern="^(up|down|left|right|zoom_in|zoom_out)$")
    speed: float = Field(default=0.5, ge=0.0, le=1.0)


@router.get("", response_model=List[CameraResponse])
async def get_cameras(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera))
    cams = result.scalars().all()
    
    # Inject active recording status dynamically
    recording_ids = recorder_manager.status()
    for cam in cams:
        if cam.id in recording_ids:
            cam.status = "recording"
            
    return cams


@router.post("", response_model=CameraResponse, status_code=201)
async def create_camera(camera: CameraCreate, db: AsyncSession = Depends(get_db)):
    data = camera.model_dump()
    new_cam = Camera(**data)
    db.add(new_cam)
    await db.commit()
    await db.refresh(new_cam)
    await _refresh_recorder(db)
    return new_cam


@router.patch("/{camera_id}", response_model=CameraResponse)
async def update_camera(camera_id: str, update: CameraUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")
    for k, v in update.model_dump(exclude_unset=True).items():
        setattr(cam, k, v)
    await db.commit()
    await db.refresh(cam)
    await _refresh_recorder(db)
    return cam


@router.delete("/{camera_id}")
async def delete_camera(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")
    
    # Cascade delete associated events to avoid foreign key violations
    from sqlalchemy import delete
    from api.models.ai import SemanticEvent
    await db.execute(delete(SemanticEvent).where(SemanticEvent.camera_id == camera_id))

    # Delete camera record
    await db.delete(cam)
    await db.commit()

    # Purge video recording files and stop active streams
    from api.services.recorder import purge_all_recordings
    await asyncio.to_thread(purge_all_recordings, camera_id)
    await _refresh_recorder(db)
    return {"status": "deleted"}


@router.get("/{camera_id}/snapshot")
async def get_camera_snapshot(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    rtsp_url = cam.rtsp_url_sub or cam.rtsp_url_main
    if not rtsp_url:
        raise HTTPException(400, "Camera has no RTSP stream configured")

    cmd = [
        "ffmpeg",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-i", rtsp_url,
        "-frames:v", "1",
        "-q:v", "4",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-",
    ]
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=8.0)
    except asyncio.TimeoutError:
        if proc:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        raise HTTPException(504, "Snapshot timed out")
    except FileNotFoundError:
        raise HTTPException(500, "ffmpeg is not available in the API container")
    except Exception as e:
        if proc:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        raise HTTPException(500, f"Snapshot failed: {e}")

    if proc.returncode != 0 or not stdout:
        detail = stderr.decode(errors="replace")[-240:] if stderr else "Snapshot capture failed"
        raise HTTPException(502, detail)

    return Response(content=stdout, media_type="image/jpeg")


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
    while True:
        try:
            from api.database import async_session_maker
            async with async_session_maker() as session:
                cam = await session.get(Camera, camera_id)
                if not cam or not (cam.config or {}).get("ptz", {}).get("tour_enabled"):
                    break
                presets = (cam.config or {}).get("ptz", {}).get("presets", [])
                if not presets or not cam.onvif_endpoint:
                    break

            for preset in presets:
                preset_name = preset if isinstance(preset, str) else preset.get("name")
                if preset_name and cam.onvif_endpoint:
                    await asyncio.to_thread(
                        onvif_service.goto_preset,
                        cam.onvif_endpoint,
                        cam.onvif_username or "",
                        cam.onvif_password or "",
                        preset_name,
                    )
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            break
        except Exception:
            await asyncio.sleep(interval)


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
async def save_ptz_preset(camera_id: str, req: PTZPresetRequest, db: AsyncSession = Depends(get_db)):
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
async def toggle_ptz_tour(camera_id: str, req: PTZTourRequest, db: AsyncSession = Depends(get_db)):
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
async def discover_cameras():
    """Scan network for ONVIF cameras (WS-Discovery + IP range scan fallback)."""
    try:
        return await onvif_service.discover_cameras(timeout=4)
    except Exception as e:
        raise HTTPException(500, f"Discovery failed: {e}")


def get_default_rtsp_paths(manufacturer: str | None, model: str | None, ip: str, username: str, password: str) -> tuple[str, str | None]:
    m = (manufacturer or "").lower()
    
    if "hikvision" in m or "hik" in m:
        return (
            f"rtsp://{username}:{password}@{ip}:554/Streaming/Channels/101",
            f"rtsp://{username}:{password}@{ip}:554/Streaming/Channels/102"
        )
    elif "dahua" in m or "amcrest" in m or "lts" in m:
        return (
            f"rtsp://{username}:{password}@{ip}:554/cam/realmonitor?channel=1&subtype=0",
            f"rtsp://{username}:{password}@{ip}:554/cam/realmonitor?channel=1&subtype=1"
        )
    elif "reolink" in m:
        return (
            f"rtsp://{username}:{password}@{ip}:554/h264Preview_01_main",
            f"rtsp://{username}:{password}@{ip}:554/h264Preview_01_sub"
        )
    elif "axis" in m:
        return (
            f"rtsp://{username}:{password}@{ip}:554/axis-media/media.amp",
            None
        )
    elif "foscam" in m:
        return (
            f"rtsp://{username}:{password}@{ip}:554/videoMain",
            f"rtsp://{username}:{password}@{ip}:554/videoSub"
        )
    else:
        # Generic fallback
        return (
            f"rtsp://{username}:{password}@{ip}:554/stream1",
            f"rtsp://{username}:{password}@{ip}:554/stream2"
        )


@router.post("/adopt", response_model=CameraResponse, status_code=201)
async def adopt_camera(
    data: ONVIFDiscoveryResult,
    username: str = "admin",
    password: str = "admin",
    db: AsyncSession = Depends(get_db),
):
    """Probe a discovered device for RTSP streams, then save it."""
    import urllib.parse
    port = 80
    if data.onvif_endpoint:
        try:
            parsed = urllib.parse.urlparse(data.onvif_endpoint)
            if parsed.port:
                port = parsed.port
        except Exception:
            pass

    streams = await asyncio.to_thread(
        onvif_service.get_camera_streams,
        data.ip, port, username, password
    )

    def inject_rtsp_credentials(rtsp_url: str | None, user: str, psw: str) -> str | None:
        if not rtsp_url or not user:
            return rtsp_url
        # If credentials already embedded, skip
        if "@" in rtsp_url.split("//")[-1]:
            return rtsp_url
        prefix = "rtsp://"
        if rtsp_url.startswith("rtsps://"):
            prefix = "rtsps://"
        body = rtsp_url[len(prefix):]
        import urllib.parse
        encoded_user = urllib.parse.quote(user)
        encoded_pass = urllib.parse.quote(psw)
        return f"{prefix}{encoded_user}:{encoded_pass}@{body}"

    if streams:
        rtsp_main = inject_rtsp_credentials(streams[0].get("rtsp_url"), username, password)
        rtsp_sub  = inject_rtsp_credentials(streams[1].get("rtsp_url"), username, password) if len(streams) > 1 else None
        resolution = streams[0].get("resolution")
    else:
        # Fall back to manufacturer-specific defaults
        rtsp_main, rtsp_sub = get_default_rtsp_paths(
            data.manufacturer, data.model, data.ip, username, password
        )
        resolution = None

    cam = Camera(
        name=f"{data.manufacturer} {data.model} ({data.ip})",
        rtsp_url_main=rtsp_main,
        rtsp_url_sub=rtsp_sub,
        onvif_endpoint=data.onvif_endpoint,
        onvif_username=username,
        onvif_password=password,
        manufacturer=data.manufacturer,
        model=data.model,
        resolution=resolution,
        status="online",
        auto_adopted=True,
    )
    db.add(cam)
    await db.commit()
    await db.refresh(cam)
    await _refresh_recorder(db)
    return cam
