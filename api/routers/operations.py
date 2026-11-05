from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.config import settings
from api.database import get_db
from api.models.ai import SemanticEvent
from api.models.camera import Camera
from api.models.operations import AlertRule, EventReview, NVRConnection, PrivacyMode
from api.services.local_core import local_core
from api.services.recorder import recorder_manager

router = APIRouter(prefix="/ops-api", tags=["Operations"])


class NVRChannel(BaseModel):
    channel: int = Field(ge=1, le=128)
    name: str | None = None
    main_path: str | None = None
    sub_path: str | None = None
    enabled: bool = True


class NVRCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    vendor: Literal["hikvision", "dahua", "amcrest", "reolink", "axis", "generic", "custom"] = "generic"
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=554, ge=1, le=65535)
    username: str = ""
    password: str = ""
    channel_count: int = Field(default=4, ge=1, le=128)
    use_substreams: bool = True
    enabled: bool = True
    custom_main_template: str | None = None
    custom_sub_template: str | None = None
    channels: list[NVRChannel] = Field(default_factory=list)

    @field_validator("host")
    @classmethod
    def clean_host(cls, value: str) -> str:
        return value.replace("rtsp://", "").replace("http://", "").replace("https://", "").strip().strip("/")


class NVRUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    channel_count: int | None = Field(default=None, ge=1, le=128)
    use_substreams: bool | None = None
    channels: list[NVRChannel] | None = None


class RulePayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = True
    severity: Literal["low", "medium", "high", "critical"] = "medium"
    camera_ids: list[str] = Field(default_factory=list)
    objects: list[str] = Field(default_factory=lambda: ["person"])
    zone: str = "any"
    schedule: str = "always"
    condition: str = "present"
    threshold_seconds: int = Field(default=0, ge=0, le=86400)
    cooldown_seconds: int = Field(default=120, ge=0, le=86400)
    actions: list[str] = Field(default_factory=lambda: ["record", "notify"])


class PrivacyPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = False
    camera_ids: list[str] = Field(default_factory=list)
    schedule: str = "always"
    mode: Literal["disable_camera", "mask_recording", "disable_ai", "local_only"] = "disable_ai"
    reason: str = ""


class ReviewPayload(BaseModel):
    verdict: Literal["useful", "false_positive", "evidence", "training", "unreviewed"]
    note: str = ""
    tags: list[str] = Field(default_factory=list)


def _credentials(username: str, password: str) -> str:
    if not username:
        return ""
    return f"{quote(username)}:{quote(password)}@"


def _channel_paths(vendor: str, channel: int, custom_main: str | None = None, custom_sub: str | None = None) -> tuple[str, str | None]:
    if vendor == "hikvision":
        return f"/Streaming/Channels/{channel}01", f"/Streaming/Channels/{channel}02"
    if vendor in {"dahua", "amcrest"}:
        return f"/cam/realmonitor?channel={channel}&subtype=0", f"/cam/realmonitor?channel={channel}&subtype=1"
    if vendor == "reolink":
        return f"/h264Preview_{channel:02d}_main", f"/h264Preview_{channel:02d}_sub"
    if vendor == "axis":
        return f"/axis-media/media.amp?camera={channel}", None
    if vendor == "custom":
        main = (custom_main or "/channel/{channel}/main").format(channel=channel)
        sub = (custom_sub or "").format(channel=channel) if custom_sub else None
        return main, sub
    return f"/channel/{channel}/main", f"/channel/{channel}/sub"


def _rtsp_url(host: str, port: int | str, username: str, password: str, path: str) -> str:
    normalized_path = path if path.startswith("/") else f"/{path}"
    return f"rtsp://{_credentials(username, password)}{host}:{port}{normalized_path}"


def _mask_channels(channels: list) -> list:
    from api.security import mask_rtsp_url
    masked = []
    for channel in channels or []:
        if not isinstance(channel, dict):
            masked.append(channel)
            continue
        item = dict(channel)
        for key in ("rtsp_url_main", "rtsp_url_sub", "rtsp_url"):
            if key in item:
                item[key] = mask_rtsp_url(item.get(key))
        if item.get("password"):
            item["password"] = "********"
        masked.append(item)
    return masked


def _nvr_response(nvr: NVRConnection, *, reveal_secrets: bool = False) -> dict[str, Any]:
    config = nvr.config or {}
    channels = config.get("channels", [])
    return {
        "id": nvr.id,
        "name": nvr.name,
        "vendor": nvr.vendor,
        "host": nvr.host,
        "port": int(nvr.port),
        "username": nvr.username or "",
        "password": nvr.password if reveal_secrets else None,
        "enabled": nvr.enabled,
        "status": nvr.status,
        "channel_count": config.get("channel_count", 0),
        "use_substreams": config.get("use_substreams", True),
        "channels": channels if reveal_secrets else _mask_channels(channels),
        "created_at": nvr.created_at.isoformat() if nvr.created_at else None,
        "updated_at": nvr.updated_at.isoformat() if nvr.updated_at else None,
    }


async def _refresh_recorders(db: AsyncSession) -> None:
    result = await db.execute(select(Camera))
    await recorder_manager.sync_cameras(result.scalars().all())
    await local_core.refresh_snapshot()


def _recording_dir_size() -> dict[str, Any]:
    root = Path(settings.recordings_dir)
    files = 0
    total = 0
    newest: float | None = None
    try:
        if root.exists():
            for path in root.rglob("*"):
                if path.is_file():
                    try:
                        stat = path.stat()
                    except OSError:
                        continue
                    files += 1
                    total += stat.st_size
                    newest = max(newest or stat.st_mtime, stat.st_mtime)
    except Exception:
        pass
    return {
        "files": files,
        "gb": round(total / (1024 ** 3), 3),
        "latest_recording": datetime.fromtimestamp(newest, tz=timezone.utc).isoformat() if newest else None,
    }


@router.get("/health-center")
async def health_center(db: AsyncSession = Depends(get_db)):
    cameras = (await db.execute(select(Camera))).scalars().all()
    nvrs = (await db.execute(select(NVRConnection))).scalars().all()
    events = (await db.execute(select(SemanticEvent).order_by(SemanticEvent.timestamp.desc()).limit(25))).scalars().all()
    recorder_status = recorder_manager.status()
    actively_recording = {cid for cid, state in recorder_status.items() if state == "recording"}
    storage = await asyncio.to_thread(_recording_dir_size)
    offline = [cam for cam in cameras if cam.status == "offline" or not cam.enabled]
    recording_gaps = [cam for cam in cameras if cam.enabled and cam.id not in actively_recording]

    issues = []
    for cam in offline:
        issues.append({"scope": "camera", "id": cam.id, "name": cam.name, "severity": "high", "message": "Camera is offline or disabled"})
    for cam in recording_gaps:
        issues.append({"scope": "recording", "id": cam.id, "name": cam.name, "severity": "critical", "message": "Recorder is not active for this enabled camera"})
    if not cameras:
        issues.append({"scope": "setup", "severity": "medium", "message": "No cameras have been added yet"})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "cameras": len(cameras),
            "recording": len(actively_recording),
            "offline": len(offline),
            "nvrs": len(nvrs),
            "events_loaded": len(events),
            "recording_files": storage["files"],
            "recording_gb": storage["gb"],
        },
        "issues": issues,
        "recorders": recorder_status,
        "storage": storage,
        "recent_events": [
            {
                "id": event.id,
                "camera_id": event.camera_id,
                "object_class": event.object_class,
                "confidence": event.confidence,
                "timestamp": event.timestamp.isoformat() if event.timestamp else None,
            }
            for event in events
        ],
    }


@router.post("/nvrs/preview")
async def preview_nvr(payload: NVRCreate):
    channels = payload.channels or [NVRChannel(channel=i) for i in range(1, payload.channel_count + 1)]
    preview = []
    for item in channels:
        main_path, sub_path = _channel_paths(payload.vendor, item.channel, payload.custom_main_template, payload.custom_sub_template)
        main_path = item.main_path or main_path
        sub_path = item.sub_path if item.sub_path is not None else sub_path
        preview.append({
            "channel": item.channel,
            "name": item.name or f"{payload.name} CH{item.channel}",
            "enabled": item.enabled,
            "rtsp_url_main": _rtsp_url(payload.host, payload.port, payload.username, payload.password, main_path),
            "rtsp_url_sub": _rtsp_url(payload.host, payload.port, payload.username, payload.password, sub_path) if payload.use_substreams and sub_path else None,
        })
    return {"channels": preview}


def _reveal_secrets(request: Request) -> bool:
    from api.security import can_view_secrets
    return can_view_secrets(getattr(request.state, "user", None))


@router.get("/nvrs")
async def list_nvrs(request: Request, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(NVRConnection).order_by(NVRConnection.created_at.desc()))
    reveal = _reveal_secrets(request)
    return [_nvr_response(nvr, reveal_secrets=reveal) for nvr in result.scalars().all()]


@router.post("/nvrs", status_code=201)
async def create_nvr(payload: NVRCreate, request: Request, db: AsyncSession = Depends(get_db)):
    preview = (await preview_nvr(payload))["channels"]
    nvr = NVRConnection(
        name=payload.name,
        vendor=payload.vendor,
        host=payload.host,
        port=str(payload.port),
        username=payload.username,
        password=payload.password,
        enabled=payload.enabled,
        status="imported",
        config={
            "channel_count": payload.channel_count,
            "use_substreams": payload.use_substreams,
            "channels": preview,
        },
    )
    db.add(nvr)
    created = []
    for channel in preview:
        if not channel["enabled"]:
            continue
        cam = Camera(
            name=channel["name"],
            rtsp_url_main=channel["rtsp_url_main"],
            rtsp_url_sub=channel["rtsp_url_sub"],
            manufacturer=payload.vendor,
            model="Imported NVR channel",
            status="online",
            auto_adopted=True,
            enabled=payload.enabled,
            config={"source": "nvr", "nvr_id": nvr.id, "channel": channel["channel"]},
        )
        db.add(cam)
        created.append(cam)
    await db.commit()
    await _refresh_recorders(db)
    return {"nvr": _nvr_response(nvr, reveal_secrets=_reveal_secrets(request)), "created_cameras": len(created)}


@router.patch("/nvrs/{nvr_id}")
async def update_nvr(nvr_id: str, payload: NVRUpdate, request: Request, db: AsyncSession = Depends(get_db)):
    nvr = await db.get(NVRConnection, nvr_id)
    if not nvr:
        raise HTTPException(404, "NVR not found")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"]:
        nvr.name = updates["name"]
    if "enabled" in updates:
        nvr.enabled = updates["enabled"]
    config = dict(nvr.config or {})
    for key in ("channel_count", "use_substreams", "channels"):
        if key in updates:
            value = updates[key]
            if key == "channels" and value is not None:
                value = [item.model_dump() for item in value]
            config[key] = value
    nvr.config = config
    await db.commit()
    return _nvr_response(nvr, reveal_secrets=_reveal_secrets(request))


@router.delete("/nvrs/{nvr_id}")
async def delete_nvr(nvr_id: str, remove_cameras: bool = True, db: AsyncSession = Depends(get_db)):
    nvr = await db.get(NVRConnection, nvr_id)
    if not nvr:
        raise HTTPException(404, "NVR not found")
    if remove_cameras:
        from api.services.recorder import purge_all_recordings
        cams = (await db.execute(select(Camera))).scalars().all()
        for cam in cams:
            if (cam.config or {}).get("nvr_id") == nvr_id:
                # Delete associated events to prevent FK violations
                await db.execute(delete(SemanticEvent).where(SemanticEvent.camera_id == cam.id))
                await db.delete(cam)
                await asyncio.to_thread(purge_all_recordings, cam.id)
    await db.delete(nvr)
    await db.commit()
    await _refresh_recorders(db)
    return {"status": "deleted"}


@router.get("/alert-rules")
async def list_alert_rules(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(AlertRule).order_by(AlertRule.created_at.desc()))).scalars().all()
    results = []
    for row in rows:
        cfg = dict(row.config or {})
        # Only return operations alert rules (or normalize automation rules)
        results.append({
            "objects": ["person"],
            "camera_ids": [],
            "schedule": "always",
            "zone": "any",
            "condition": "present",
            "threshold_seconds": 0,
            "cooldown_seconds": 120,
            "actions": ["record", "notify"],
            **cfg,
            "id": row.id,
            "name": row.name,
            "enabled": row.enabled,
            "severity": row.severity or "medium",
        })
    return results


@router.post("/alert-rules", status_code=201)
async def create_alert_rule(payload: RulePayload, db: AsyncSession = Depends(get_db)):
    rule = AlertRule(name=payload.name, enabled=payload.enabled, severity=payload.severity, config=payload.model_dump())
    db.add(rule)
    await db.commit()
    return {**payload.model_dump(), "id": rule.id}


@router.patch("/alert-rules/{rule_id}")
async def update_alert_rule(rule_id: str, payload: RulePayload, db: AsyncSession = Depends(get_db)):
    rule = await db.get(AlertRule, rule_id)
    if not rule:
        raise HTTPException(404, "Alert rule not found")
    rule.name = payload.name
    rule.enabled = payload.enabled
    rule.severity = payload.severity
    rule.config = payload.model_dump()
    await db.commit()
    return {**payload.model_dump(), "id": rule.id}


@router.post("/alert-rules/{rule_id}/test")
async def test_alert_rule(rule_id: str, db: AsyncSession = Depends(get_db)):
    rule = await db.get(AlertRule, rule_id)
    if not rule:
        raise HTTPException(404, "Alert rule not found")
    cfg = dict(rule.config or {})
    target_cams = cfg.get("camera_ids", [])
    cam_id = target_cams[0] if target_cams else "all"

    from datetime import datetime, timezone
    from api.models.ai import SemanticEvent

    test_obj = cfg.get("objects", ["person"])[0] if cfg.get("objects") else "person"
    sim_event = SemanticEvent(
        camera_id=cam_id if cam_id != "all" else "system",
        object_class=f"test_{test_obj}",
        confidence=0.99,
        description=f"Rule Simulation Dispatch: {rule.name}",
        timestamp=datetime.now(timezone.utc),
    )
    db.add(sim_event)
    await db.commit()
    return {
        "status": "tested",
        "rule_id": rule.id,
        "rule_name": rule.name,
        "actions_triggered": cfg.get("actions", ["notify"]),
        "message": f"Alert rule '{rule.name}' test dispatch executed successfully.",
    }


@router.delete("/alert-rules/{rule_id}")
async def delete_alert_rule(rule_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(AlertRule).where(AlertRule.id == rule_id))
    await db.commit()
    return {"status": "deleted"}


@router.get("/privacy-modes")
async def list_privacy_modes(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(PrivacyMode).order_by(PrivacyMode.created_at.desc()))).scalars().all()
    return [{**(row.config or {}), "id": row.id, "name": row.name, "enabled": row.enabled} for row in rows]


@router.post("/privacy-modes", status_code=201)
async def create_privacy_mode(payload: PrivacyPayload, db: AsyncSession = Depends(get_db)):
    mode = PrivacyMode(name=payload.name, enabled=payload.enabled, config=payload.model_dump())
    db.add(mode)
    await db.commit()
    return {**payload.model_dump(), "id": mode.id}


@router.patch("/privacy-modes/{mode_id}")
async def update_privacy_mode(mode_id: str, payload: PrivacyPayload, db: AsyncSession = Depends(get_db)):
    mode = await db.get(PrivacyMode, mode_id)
    if not mode:
        raise HTTPException(404, "Privacy mode not found")
    mode.name = payload.name
    mode.enabled = payload.enabled
    mode.config = payload.model_dump()
    await db.commit()
    return {**payload.model_dump(), "id": mode.id}


@router.delete("/privacy-modes/{mode_id}")
async def delete_privacy_mode(mode_id: str, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(PrivacyMode).where(PrivacyMode.id == mode_id))
    await db.commit()
    return {"status": "deleted"}


@router.get("/event-reviews")
async def list_event_reviews(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(EventReview).order_by(EventReview.updated_at.desc()))).scalars().all()
    return [
        {
            "id": row.id,
            "event_id": row.event_id,
            "verdict": row.verdict,
            "note": row.note or "",
            "tags": (row.config or {}).get("tags", []),
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
        for row in rows
    ]


@router.put("/event-reviews/{event_id}")
async def review_event(event_id: str, payload: ReviewPayload, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(EventReview).where(EventReview.event_id == event_id))).scalar_one_or_none()
    if row is None:
        row = EventReview(event_id=event_id)
        db.add(row)
    row.verdict = payload.verdict
    row.note = payload.note
    row.config = {"tags": payload.tags}
    await db.commit()
    return {"event_id": event_id, **payload.model_dump()}
