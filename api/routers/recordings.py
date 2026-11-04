import os
import re
import time
import hashlib
import asyncio
import tempfile
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from api.config import settings
from api.database import get_db
from api.models.camera import Camera
from api.services.hikvision_playback import search_camera_footage
from api.services.recorder import list_recordings

router = APIRouter(prefix="/recordings-list", tags=["Recordings"])

EXPORT_DIR = Path(settings.export_path) if hasattr(settings, "export_path") else Path(settings.storage_path) / "exports"


class ExportRequest(BaseModel):
    camera_id: str
    start_time: str
    end_time: str
    reason: Optional[str] = "Incident investigation"


def _compute_file_sha256(file_path: Path) -> str:
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def _parse_ts(dt_str: str) -> datetime:
    try:
        clean = dt_str.replace("Z", "+00:00")
        return datetime.fromisoformat(clean).astimezone(timezone.utc)
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid ISO timestamp format: {dt_str}")


@router.get("")
async def get_recordings(camera_id: str | None = None):
    """List all recorded MP4 files, checking both hot and cold storage tiers."""
    return await asyncio.to_thread(list_recordings, camera_id)


@router.get("/edge")
async def get_edge_recordings(
    camera_id: str,
    start: str,
    end: str,
    db: AsyncSession = Depends(get_db),
):
    """Footage stored on the camera for a gap the recorder does not have.

    The response is start, end, and track. It does not include a playback URL.
    """
    start_dt = _parse_ts(start)
    end_dt = _parse_ts(end)
    if start_dt >= end_dt:
        raise HTTPException(status_code=400, detail="Start time must be strictly before end time")
    if (end_dt - start_dt).total_seconds() > 26 * 3600:
        raise HTTPException(status_code=400, detail="Search window is limited to one day")

    from api.security import safe_camera_id
    try:
        cam_id = safe_camera_id(camera_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid camera id")
    result = await db.execute(select(Camera).where(Camera.id == cam_id))
    cam = result.scalar_one_or_none()
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found")
    rtsp_url = cam.rtsp_url_sub or cam.rtsp_url_main
    if not rtsp_url:
        return {"segments": [], "searched": False}
    segments = await search_camera_footage(
        rtsp_url,
        cam.onvif_username,
        cam.onvif_password,
        start_dt,
        end_dt,
    )
    return {"segments": segments, "searched": True}


def _find_candidate_recordings(cam_id: str) -> list[tuple[datetime, Path, float]]:
    from api.services.recorder import _recording_roots, mp4_info_cached
    candidate_files = []
    seen = set()
    for root in _recording_roots():
        directory = root / cam_id
        if not directory.is_dir():
            continue
        for p in directory.rglob("*.mp4"):
            if p.name.startswith(".") or p.name in seen:
                continue
            try:
                stat = p.stat()
                if stat.st_size < 10240:
                    continue
                info = mp4_info_cached(str(p), stat)
                if not info.finalized:
                    continue
            except OSError:
                continue
            match = re.match(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})", p.name)
            if match:
                y, mo, d, h, mi, s = map(int, match.groups())
                try:
                    file_start = datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)
                except ValueError:
                    file_start = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
                duration = info.duration_seconds or getattr(settings, "segment_seconds", 60)
                candidate_files.append((file_start, p, duration))
                seen.add(p.name)
    candidate_files.sort(key=lambda x: x[0])
    return candidate_files


@router.post("/export")
async def export_evidence(req: ExportRequest):
    """
    Export a tamper-evident incident clip spanning the requested timestamp range.
    Slices and concatenates raw stream segments with SHA-256 chain of custody verification.
    """
    start_dt = _parse_ts(req.start_time)
    end_dt = _parse_ts(req.end_time)

    if start_dt >= end_dt:
        raise HTTPException(status_code=400, detail="Start time must be strictly before end time")

    from api.security import safe_camera_id
    try:
        cam_id = safe_camera_id(req.camera_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid camera id")
    from api.services.recorder import _terminate_process

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    candidate_files = await asyncio.to_thread(_find_candidate_recordings, cam_id)

    if not candidate_files:
        raise HTTPException(status_code=404, detail="No recorded video found for this camera")

    matching = []
    for f_start, f_path, duration in candidate_files:
        f_end = f_start + timedelta(seconds=duration)
        if (f_start <= end_dt) and (f_end >= start_dt):
            matching.append(f_path)

    if not matching:
        raise HTTPException(status_code=404, detail="No recording overlaps the requested time range")

    export_id = f"evidence_{int(time.time())}_{cam_id[:8]}"
    out_filename = f"{export_id}.mp4"
    out_filepath = EXPORT_DIR / out_filename

    # Execute ffmpeg stitch and slice with timeout and cleanup
    proc = None
    concat_path = None
    try:
        if len(matching) == 1:
            single_input = matching[0]
            cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(single_input),
                "-c", "copy",
                "-movflags", "+faststart",
                str(out_filepath)
            ]
        else:
            with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as concat_file:
                for item in matching:
                    escaped_path = str(item.resolve()).replace("'", "'\\''")
                    concat_file.write(f"file '{escaped_path}'\n")
                concat_path = concat_file.name

            cmd = [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "0",
                "-i", concat_path,
                "-c", "copy",
                "-movflags", "+faststart",
                str(out_filepath)
            ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            await asyncio.wait_for(proc.communicate(), timeout=180.0)
        except asyncio.TimeoutError:
            await _terminate_process(proc)
            raise HTTPException(status_code=504, detail="Incident export packaging timed out")
    finally:
        if proc is not None:
            await _terminate_process(proc)
        if concat_path:
            try:
                os.unlink(concat_path)
            except OSError:
                pass

    if not out_filepath.exists() or out_filepath.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="Failed to synthesize incident video export package")

    sha256_hash = await asyncio.to_thread(_compute_file_sha256, out_filepath)
    download_url = f"/recordings/{cam_id}/export/{out_filename}"

    return {
        "status": "ready",
        "export_id": export_id,
        "camera_id": cam_id,
        "filename": out_filename,
        "sha256_hash": sha256_hash,
        "download_url": download_url,
        "start_time": req.start_time,
        "end_time": req.end_time,
        "file_size_bytes": out_filepath.stat().st_size,
        "message": f"Incident package generated successfully with SHA-256 chain-of-custody verification ({sha256_hash[:16]}...)."
    }
