from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, text
import asyncio
import psutil
import shutil
import os
import sys
import yaml
import json
import urllib.request
from pathlib import Path
from api.config import settings
from api.services.local_core import local_core, sse_pack
from api.database import get_db
from sqlalchemy.ext.asyncio import AsyncSession
from api.models.ai import Face, SemanticEvent
from api.models.camera import Camera
from api.models.operations import AlertRule, EventReview, NVRConnection, PrivacyMode
from api.models.user import User
from api.routers.auth import get_current_user
from api.services.recorder import purge_all_recordings

router = APIRouter(prefix="/system", tags=["system"])

CONFIG_PATH = Path(os.environ.get("SENTINEL_CONFIG_FILE", "sentinel.yml"))
EXPORT_DIR = Path(settings.export_path)


class AIConfig(BaseModel):
    accelerator: str = "auto"
    object_model: str = "yolov8n"
    min_confidence: float = Field(default=0.65, ge=0, le=1)
    enable_alpr: bool = False
    enable_face_recognition: bool = False
    ai_provider: str = "local"
    gemini_api_key: str = ""
    openai_api_key: str = ""


class NetworkConfig(BaseModel):
    api_port: int = 8000
    rtsp_port: int = 8554
    webrtc_api_port: int = 1984
    webrtc_port: int = 8555
    ice_servers: list[str] = Field(default_factory=list)
    enable_ssl: bool = False


class UpdateConfig(BaseModel):
    manifest_url: str = "https://updates.chriskendall.media/sentinel/latest.json"
    auto_download: bool = False
    check_interval_minutes: int = Field(default=360, ge=15, le=10080)


class SystemConfigUpdate(BaseModel):
    retention_days: int = Field(default=30, ge=0, le=3650)
    ai: AIConfig = Field(default_factory=AIConfig)
    network: NetworkConfig = Field(default_factory=NetworkConfig)
    updates: UpdateConfig = Field(default_factory=UpdateConfig)


def _read_config_file() -> dict:
    if CONFIG_PATH.is_file():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                return yaml.safe_load(fh) or {}
        except Exception:
            return {}
    return {}


def _compose_config(data: dict) -> SystemConfigUpdate:
    recordings = data.get("recordings", {}) if isinstance(data.get("recordings"), dict) else {}
    ai = data.get("ai", {}) if isinstance(data.get("ai"), dict) else {}
    network = data.get("network", {}) if isinstance(data.get("network"), dict) else {}
    go2rtc = data.get("go2rtc", {}) if isinstance(data.get("go2rtc"), dict) else {}
    updates = data.get("updates", {}) if isinstance(data.get("updates"), dict) else {}

    ice_servers = network.get("ice_servers")
    if ice_servers is None:
        ice_servers = go2rtc.get("ice_servers", ["stun:stun.l.google.com:19302"])

    return SystemConfigUpdate(
        retention_days=recordings.get("retention_days", settings.retention_days),
        ai=AIConfig(
            accelerator=ai.get("accelerator", "auto"),
            object_model=ai.get("object_model", "yolov8n"),
            min_confidence=ai.get("min_confidence", 0.65),
            enable_alpr=ai.get("enable_alpr", False),
            enable_face_recognition=ai.get("enable_face_recognition", False),
            ai_provider=ai.get("ai_provider", settings.ai_provider),
            gemini_api_key=ai.get("gemini_api_key", settings.gemini_api_key),
            openai_api_key=ai.get("openai_api_key", settings.openai_api_key),
        ),
        network=NetworkConfig(
            api_port=network.get("api_port", 8000),
            rtsp_port=network.get("rtsp_port", 8554),
            webrtc_api_port=network.get("webrtc_api_port", 1984),
            webrtc_port=network.get("webrtc_port", 8555),
            ice_servers=ice_servers or [],
            enable_ssl=network.get("enable_ssl", False),
        ),
        updates=UpdateConfig(
            manifest_url=updates.get("manifest_url", os.getenv("SENTINEL_UPDATE_MANIFEST_URL", "https://updates.chriskendall.media/sentinel/latest.json")),
            auto_download=updates.get("auto_download", False),
            check_interval_minutes=updates.get("check_interval_minutes", 360),
        ),
    )


def _install_dir() -> Path:
    install_dir = Path("/opt/mview-sentinel")
    if not install_dir.is_dir() or not (install_dir / ".git").is_dir():
        install_dir = Path(os.getcwd())
    return install_dir


def _manifest_url() -> str:
    return _compose_config(_read_config_file()).updates.manifest_url


def _fetch_update_manifest(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "mView-Sentinel-Updater/1.0"})
    with urllib.request.urlopen(request, timeout=12) as response:
        body = response.read(1024 * 1024)
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Update manifest must be a JSON object")
    return payload


async def _git_output(install_dir: Path, *args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=str(install_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(stderr.decode(errors="replace").strip() or f"git {' '.join(args)} failed")
    return stdout.decode().strip()


def _manifest_target(manifest: dict) -> dict:
    github = manifest.get("github") if isinstance(manifest.get("github"), dict) else {}
    target_sha = (
        manifest.get("sha")
        or manifest.get("commit")
        or manifest.get("commit_sha")
        or manifest.get("latest_sha")
        or github.get("sha")
        or github.get("commit")
    )
    target_ref = (
        manifest.get("ref")
        or manifest.get("tag")
        or manifest.get("branch")
        or github.get("ref")
        or github.get("tag")
        or github.get("branch")
        or "main"
    )
    repo_url = (
        manifest.get("repository")
        or manifest.get("repo")
        or manifest.get("github_repo")
        or github.get("repository")
        or github.get("repo")
    )
    download_url = (
        manifest.get("download_url")
        or manifest.get("archive_url")
        or manifest.get("zipball_url")
        or github.get("download_url")
        or github.get("archive_url")
        or github.get("zipball_url")
    )
    version = manifest.get("version") or manifest.get("name") or target_ref
    return {
        "sha": str(target_sha).strip() if target_sha else "",
        "ref": str(target_ref).strip(),
        "repo": str(repo_url).strip() if repo_url else "",
        "download_url": str(download_url).strip() if download_url else "",
        "version": str(version).strip() if version else "",
        "notes": manifest.get("notes") or manifest.get("release_notes") or "",
    }


async def _build_update_status() -> dict:
    install_dir = _install_dir()
    manifest_url = _manifest_url()
    if not (install_dir / ".git").is_dir():
        return {
            "update_available": False,
            "manifest_url": manifest_url,
            "current_sha": "unknown",
            "latest_sha": "unknown",
            "error": "Not a git repository",
        }

    try:
        local_sha = await _git_output(install_dir, "rev-parse", "HEAD")
        manifest = await asyncio.to_thread(_fetch_update_manifest, manifest_url)
        target = _manifest_target(manifest)
        latest_sha = target["sha"]
        if not latest_sha:
            remote_ref = target["ref"] or "main"
            repo = target["repo"] or "origin"
            if repo == "origin":
                remote_output = await _git_output(install_dir, "ls-remote", "origin", remote_ref)
            else:
                remote_output = await _git_output(install_dir, "ls-remote", repo, remote_ref)
            latest_sha = remote_output.split()[0] if remote_output else ""
        if not latest_sha:
            raise ValueError("Manifest does not expose a usable sha, commit, ref, tag, or branch")
        return {
            "update_available": local_sha != latest_sha,
            "manifest_url": manifest_url,
            "current_sha": local_sha[:7],
            "latest_sha": latest_sha[:7],
            "current_sha_full": local_sha,
            "latest_sha_full": latest_sha,
            "version": target["version"],
            "ref": target["ref"],
            "download_url": target["download_url"],
            "notes": target["notes"],
        }
    except Exception as e:
        return {
            "update_available": False,
            "manifest_url": manifest_url,
            "current_sha": "unknown",
            "latest_sha": "unknown",
            "error": str(e),
        }


def _start_update_process(install_dir: Path, manifest_url: str) -> None:
    script = """
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

install_dir = pathlib.Path(sys.argv[1])
manifest_url = sys.argv[2]
time.sleep(2)

request = urllib.request.Request(manifest_url, headers={"User-Agent": "mView-Sentinel-Updater/1.0"})
with urllib.request.urlopen(request, timeout=20) as response:
    manifest = json.loads(response.read(1024 * 1024).decode("utf-8"))
github = manifest.get("github") if isinstance(manifest.get("github"), dict) else {}
repo = manifest.get("repository") or manifest.get("repo") or manifest.get("github_repo") or github.get("repository") or github.get("repo") or "origin"
target = manifest.get("sha") or manifest.get("commit") or manifest.get("commit_sha") or manifest.get("latest_sha") or github.get("sha") or github.get("commit")
ref = manifest.get("ref") or manifest.get("tag") or manifest.get("branch") or github.get("ref") or github.get("tag") or github.get("branch") or "main"
remote = "origin"
if repo and repo != "origin":
    subprocess.run(["git", "remote", "set-url", "origin", repo], cwd=install_dir, check=False)
subprocess.run(["git", "fetch", "--prune", remote], cwd=install_dir, check=True)
checkout_target = target or f"{remote}/{ref}"
subprocess.run(["git", "reset", "--hard", checkout_target], cwd=install_dir, check=True)
subprocess.run(["git", "clean", "-fd", "--exclude", "sentinel.yml", "--exclude", ".env"], cwd=install_dir, check=True)
if (install_dir / "docker-compose.yml").is_file():
    subprocess.run(["docker", "compose", "up", "-d", "--build"], cwd=install_dir, check=True)
"""
    import subprocess
    subprocess.Popen(
        [sys.executable, "-c", script, str(install_dir), manifest_url],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=os.name != "nt",
    )


@router.get("/health")
async def get_system_health():
    """Retrieve CPU, RAM, and Disk health statistics."""
    snapshot = await local_core.get_snapshot()
    if snapshot.get("health"):
        return snapshot["health"]

    cpu_percent = psutil.cpu_percent(interval=None)
    memory = psutil.virtual_memory()
    net = psutil.net_io_counters()
    
    storage_path = settings.storage_path
    try:
        total, used, free = shutil.disk_usage(storage_path)
    except FileNotFoundError:
        total, used, free = (0, 0, 0)
    total_gb = round(total / (1024**3), 2)
    used_gb = round(used / (1024**3), 2)
    free_gb = round(free / (1024**3), 2)

    return {
        "status": "online",
        "cpu_usage_percent": cpu_percent,
        "memory_usage_percent": memory.percent,
        "memory_total_gb": round(memory.total / (1024**3), 2),
        "network": {
            "bytes_sent": net.bytes_sent,
            "bytes_recv": net.bytes_recv,
        },
        "storage": {
            "path": storage_path,
            "total_gb": total_gb,
            "used_gb": used_gb,
            "free_gb": free_gb,
            "usage_percent": round((used / total) * 100, 2) if total > 0 else 0
        }
    }


@router.get("/live")
async def live_system_state(request: Request):
    """Stream local appliance state to the UI without repeated API polling."""
    queue = await local_core.subscribe()

    async def stream():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                    yield sse_pack(event)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await local_core.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/storage-report")
async def get_storage_report():
    from api.services.recorder import storage_report
    return await asyncio.to_thread(storage_report)


@router.get("/stream-diagnostics")
async def get_stream_diagnostics():
    from api.services.recorder import recorder_manager
    return recorder_manager.diagnostics()


@router.post("/backup")
async def backup_database(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can create backups")

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    from datetime import datetime, timezone
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = EXPORT_DIR / f"mview-backup-{timestamp}.json"

    async def rows(model):
        result = await db.execute(select(model))
        payload = []
        for obj in result.scalars().all():
            item = {}
            for column in obj.__table__.columns:
                value = getattr(obj, column.name)
                if hasattr(value, "isoformat"):
                    value = value.isoformat()
                item[column.name] = value
            payload.append(item)
        return payload

    payload = {
        "created_at": timestamp,
        "version": settings.app_version,
        "config": _read_config_file(),
        "cameras": await rows(Camera),
        "users": await rows(User),
        "faces": await rows(Face),
        "semantic_events": await rows(SemanticEvent),
        "nvr_connections": await rows(NVRConnection),
        "alert_rules": await rows(AlertRule),
        "privacy_modes": await rows(PrivacyMode),
        "event_reviews": await rows(EventReview),
    }
    backup_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return FileResponse(
        str(backup_path),
        media_type="application/json",
        filename=backup_path.name,
    )


@router.post("/recordings/purge")
@router.post("/purge-recordings")
async def purge_recordings(camera_id: str | None = Query(default=None)):
    from api.services.recorder import purge_all_recordings, storage_report
    result = await asyncio.to_thread(purge_all_recordings, camera_id)
    report = await asyncio.to_thread(storage_report)
    await local_core.refresh_snapshot(include_storage=True)
    return {"status": "purged", **result, "storage_report": report}


@router.get("/diagnostics")
async def run_diagnostics(db: AsyncSession = Depends(get_db)):
    """Run an automated diagnostic audit on database, go2rtc, storage, and workers."""
    import httpx, shutil
    from datetime import datetime, timezone
    db_ok = False
    try:
        from sqlalchemy import select
        await db.execute(select(1))
        db_ok = True
    except Exception:
        pass

    go2rtc_ok = False
    try:
        url = getattr(settings, "go2rtc_url", "http://127.0.0.1:1984").rstrip('/')
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(f"{url}/api/streams")
            go2rtc_ok = res.status_code == 200
    except Exception:
        pass

    storage_target = settings.storage_path if (hasattr(settings, "storage_path") and os.path.exists(settings.storage_path)) else "."
    free_gb = 0.0
    total_gb = 0.0
    usage_percent = 0.0
    try:
        disk = shutil.disk_usage(storage_target)
        free_gb = round(disk.free / 1_073_741_824, 2)
        total_gb = round(disk.total / 1_073_741_824, 2)
        if disk.total > 0:
            usage_percent = round(((disk.total - disk.free) / disk.total) * 100, 1)
    except Exception:
        pass

    return {
        "status": "healthy" if (db_ok and go2rtc_ok) else "degraded",
        "database_connected": db_ok,
        "go2rtc_active": go2rtc_ok,
        "storage": {
            "free_gb": free_gb,
            "total_gb": total_gb,
            "usage_percent": usage_percent
        },
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.post("/maintenance/vacuum")
async def vacuum_database(db: AsyncSession = Depends(get_db)):
    """Re-index and clean orphaned records to optimize query speed."""
    from sqlalchemy import text
    from api.database import engine as _engine
    try:
        if _engine.dialect.name == "postgresql":
            await db.execute(text("ANALYZE;"))
        else:
            await db.execute(text("VACUUM;"))
        return {"status": "success", "message": "Database query statistics re-indexed."}
    except Exception as e:
        return {"status": "error", "message": str(e)}



@router.get("/config")
async def get_system_config():
    """Retrieve system configuration settings."""
    return _compose_config(_read_config_file()).model_dump()


@router.post("/config")
async def update_system_config(config: SystemConfigUpdate):
    """Update system configuration settings."""
    data = _read_config_file()

    if "recordings" not in data:
        data["recordings"] = {}

    data["recordings"]["retention_days"] = config.retention_days
    data["ai"] = config.ai.model_dump()
    data["network"] = config.network.model_dump()
    data["updates"] = config.updates.model_dump()

    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
            yaml.safe_dump(data, fh, default_flow_style=False)
    except Exception as e:
        raise HTTPException(500, f"Failed to write configuration: {e}")
        
    settings.retention_days = config.retention_days
    for key, value in config.ai.model_dump().items():
        if key in ("ai_provider", "gemini_api_key", "openai_api_key"):
            if hasattr(settings, key):
                setattr(settings, key, value)
        else:
            setting_name = f"ai_{key}"
            if hasattr(settings, setting_name):
                setattr(settings, setting_name, value)
    for key, value in config.network.model_dump().items():
        setting_name = f"network_{key}"
        if hasattr(settings, setting_name):
            setattr(settings, setting_name, value)

    return {"status": "success", **config.model_dump()}


@router.post("/factory-reset")
async def factory_reset(
    db: AsyncSession = Depends(get_db),
    current_user: dict = Depends(get_current_user)
):
    """
    DANGER: Factory reset the entire NVR.
    Wipes all recordings, all cameras, clears the database, and resets configuration to defaults.
    """
    if current_user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can perform a factory reset")

    # 1. Stop all recorders
    from api.services.recorder import recorder_manager
    recorder_manager.stop_all()

    # 2. Delete all recordings
    try:
        await asyncio.to_thread(purge_all_recordings, None)
    except Exception as e:
        print(f"Error purging recordings during factory reset: {e}")

    # 3. Wipe all tables except users. Use TRUNCATE on Postgres and portable deletes otherwise.
    from api.database import engine as _engine
    try:
        if _engine.dialect.name == "postgresql":
            await db.execute(text("TRUNCATE TABLE event_reviews, privacy_modes, alert_rules, nvr_connections, semantic_events, faces, cameras CASCADE;"))
        else:
            await db.execute(delete(EventReview))
            await db.execute(delete(PrivacyMode))
            await db.execute(delete(AlertRule))
            await db.execute(delete(NVRConnection))
            await db.execute(delete(SemanticEvent))
            await db.execute(delete(Face))
            await db.execute(delete(Camera))
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Database wipe failed: {e}")

    # 4. Reset config file to defaults by just removing it if it exists and writing an empty one
    if CONFIG_PATH.is_file():
        try:
            CONFIG_PATH.unlink()
        except Exception:
            pass

    await local_core.refresh_snapshot(include_storage=True)
    return {"status": "success", "message": "Factory reset complete. System will now restart."}


@router.post("/restart")
async def restart_services(current_user: dict = Depends(get_current_user)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can restart services")

    install_dir = Path("/opt/mview-sentinel")
    if not install_dir.is_dir() or not (install_dir / "docker-compose.yml").is_file():
        install_dir = Path(os.getcwd())
    if not (install_dir / "docker-compose.yml").is_file():
        raise HTTPException(status_code=400, detail="docker-compose.yml not found; restart is unavailable here")
    if not shutil.which("docker"):
        raise HTTPException(status_code=400, detail="Docker is not available in this environment")

    script = """
import pathlib
import subprocess
import sys
import time

install_dir = pathlib.Path(sys.argv[1])
time.sleep(2)
subprocess.run(["docker", "compose", "restart", "api", "detector"], cwd=install_dir, check=True)
"""
    try:
        import subprocess
        subprocess.Popen(
            [sys.executable, "-c", script, str(install_dir)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=os.name != "nt",
        )
        return {"status": "success", "message": "Restart initiated for API and detector services."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start restart process: {e}")


@router.get("/updates/check")
async def check_for_updates(current_user: dict = Depends(get_current_user)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can check for updates")
    return await _build_update_status()


@router.post("/updates/install")
async def install_updates(current_user: dict = Depends(get_current_user)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can install updates")

    install_dir = _install_dir()
    if not (install_dir / ".git").is_dir():
        raise HTTPException(status_code=400, detail="Not a git repository, cannot auto-update")

    status_payload = await _build_update_status()
    if status_payload.get("error"):
        raise HTTPException(status_code=400, detail=status_payload["error"])
    if not status_payload.get("update_available"):
        return {
            "status": "current",
            "message": "No update is available from the Sentinel update manifest.",
            **status_payload,
        }

    try:
        _start_update_process(install_dir, status_payload["manifest_url"])
        return {
            "status": "success",
            "message": "Update download initiated. The NVR will pull the manifest target from GitHub and rebuild in the background.",
            **status_payload,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start update process: {e}")


@router.post("/updates/auto-run")
async def auto_run_updates(current_user: dict = Depends(get_current_user)):
    if current_user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can run auto-updates")
    config = _compose_config(_read_config_file())
    if not config.updates.auto_download:
        return {"status": "disabled", "message": "Automatic update download is disabled."}
    return await install_updates(current_user)
