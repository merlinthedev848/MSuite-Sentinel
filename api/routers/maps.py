from fastapi import APIRouter, Body, Depends, UploadFile, File, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from api.database import get_db
from api.models.camera import Camera
from api.routers.cameras import _require_settings
import shutil
import os
import uuid
from pathlib import Path

router = APIRouter(prefix="/maps", tags=["maps"])

def _maps_dir() -> str:
    from api.config import settings
    preferred = Path(settings.storage_path) / "maps"
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        return str(preferred)
    except OSError:
        fallback = Path("/tmp/sentinel-maps")
        fallback.mkdir(parents=True, exist_ok=True)
        return str(fallback)


UPLOAD_DIR = _maps_dir()
CONFIG_PATH = Path(UPLOAD_DIR) / "default.json"


def _public_url(filename: str) -> str:
    return f"/static/maps/{filename}"


def _read_config() -> dict:
    if CONFIG_PATH.is_file():
        try:
            import json
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _write_config(config: dict) -> None:
    import json
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")

import aiofiles

@router.post("/upload")
async def upload_floorplan(request: Request, file: UploadFile = File(...)):
    """Upload a floorplan image to the server."""
    _require_settings(request)
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Invalid image file")
    
    file_id = str(uuid.uuid4())
    raw_name = file.filename or "floorplan.png"
    ext = raw_name.rsplit(".", 1)[-1].lower() if "." in raw_name else "png"
    if ext not in {"png", "jpg", "jpeg", "webp"}:
        raise HTTPException(status_code=400, detail="Unsupported image type")
    
    filename = f"{file_id}.{ext}"
    target_path = (Path(UPLOAD_DIR) / filename).resolve()
    if Path(UPLOAD_DIR).resolve() not in target_path.parents:
        raise HTTPException(status_code=400, detail="Invalid destination path")
    
    async with aiofiles.open(target_path, "wb") as buffer:
        while chunk := await file.read(1024 * 1024):
            await buffer.write(chunk)

    config = _read_config()
    config.update({"map_id": file_id, "floorplan_url": _public_url(filename), "floorplan_file": filename})
    config.setdefault("cameras", [])
    _write_config(config)

    return {"status": "success", "map_id": file_id, "url": _public_url(filename)}


@router.post("/{map_id}/cameras")
async def save_camera_positions(map_id: str, request: Request, positions: list = Body(...), db: AsyncSession = Depends(get_db)):
    """Save camera [x, y, rotation] coordinates for the Map View."""
    _require_settings(request)
    valid_positions = []
    for item in positions:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        valid_positions.append({
            "id": str(item["id"]),
            "x": max(0, min(100, float(item.get("x", 50)))),
            "y": max(0, min(100, float(item.get("y", 50)))),
            "rotation": max(-180, min(180, float(item.get("rotation", 0)))),
        })

    existing = await db.execute(select(Camera))
    cameras = {cam.id: cam for cam in existing.scalars().all()}
    for pos in valid_positions:
        cam = cameras.get(pos["id"])
        if not cam:
            continue
        from sqlalchemy.orm.attributes import flag_modified
        config = dict(cam.config or {})
        config["map"] = {"map_id": map_id, "x": pos["x"], "y": pos["y"], "rotation": pos["rotation"]}
        cam.config = config
        flag_modified(cam, "config")

    config = _read_config()
    config["map_id"] = map_id
    config["cameras"] = valid_positions
    _write_config(config)
    await db.commit()
    return {"status": "success", "saved": len(valid_positions)}

@router.get("/{map_id}")
async def get_map_config(map_id: str, db: AsyncSession = Depends(get_db)):
    """Retrieve map floorplan and all camera markers."""
    config = _read_config()
    saved_positions = {item.get("id"): item for item in config.get("cameras", []) if isinstance(item, dict)}

    result = await db.execute(select(Camera))
    cameras = []
    for index, cam in enumerate(result.scalars().all()):
        saved = saved_positions.get(cam.id) or (cam.config or {}).get("map") or {}
        cameras.append({
            "id": cam.id,
            "name": cam.name,
            "status": cam.status,
            "x": float(saved.get("x", 15 + (index % 5) * 17)),
            "y": float(saved.get("y", 20 + (index // 5) * 18)),
            "rotation": float(saved.get("rotation", 0)),
            "alert": cam.status == "recording",
        })

    return {
        "map_id": config.get("map_id", map_id),
        "floorplan_url": config.get("floorplan_url"),
        "cameras": cameras,
    }
