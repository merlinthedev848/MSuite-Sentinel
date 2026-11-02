from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse, JSONResponse
from starlette.background import BackgroundTask
from contextlib import asynccontextmanager
import os
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from pathlib import Path
import aiofiles
import httpx
from jose import jwt, JWTError

from api.database import engine, Base
from api.models.user import User
from api.models import operations as operations_models  # noqa: F401 - registers SQLAlchemy tables
from api.routers import cameras, recordings, events, system, auth, users, maps, operations, agent, automations
from api.services.recorder import recorder_manager
from api.services.local_core import local_snapshot_worker
from api.config import settings

log = logging.getLogger("sentinel")

# Fetch JWT config directly for the middleware
SECRET_KEY = settings.jwt_secret
ALGORITHM = settings.jwt_algorithm


async def retention_worker():
    """Background task to delete recordings older than settings.retention_days."""
    log.info("Starting retention worker background loop...")
    while True:
        try:
            retention_days = settings.retention_days
            if retention_days and retention_days > 0:
                from api.services.recorder import purge_old_recordings
                await asyncio.to_thread(purge_old_recordings, retention_days)
                
                # Clean up old database events
                try:
                    from api.database import async_session_maker
                    from sqlalchemy import delete
                    from api.models.ai import SemanticEvent
                    
                    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
                    async with async_session_maker() as session:
                        await session.execute(delete(SemanticEvent).where(SemanticEvent.timestamp < cutoff))
                        await session.commit()
                except Exception as e:
                    log.error(f"Failed to delete old events: {e}")
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.error(f"Error in retention worker: {e}")
        
        # Run every 12 hours (43200 seconds)
        await asyncio.sleep(12 * 3600)


async def auto_update_worker():
    """Periodically check the Sentinel update manifest and start an update when enabled."""
    log.info("Starting auto-update background loop...")
    while True:
        sleep_seconds = 3600  # default fallback interval
        try:
            from api.routers.system import _build_update_status, _compose_config, _install_dir, _read_config_file, _start_update_process
            config = _compose_config(_read_config_file())
            sleep_seconds = max(15, config.updates.check_interval_minutes) * 60
            if config.updates.auto_download:
                status_payload = await _build_update_status()
                if status_payload.get("update_available") and not status_payload.get("error"):
                    log.info(
                        "Update available from manifest %s: %s -> %s",
                        status_payload.get("manifest_url"),
                        status_payload.get("current_sha"),
                        status_payload.get("latest_sha"),
                    )
                    _start_update_process(_install_dir(), status_payload["manifest_url"])
                    return
                if status_payload.get("error"):
                    log.warning("Auto-update check failed: %s", status_payload["error"])
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.error("Error in auto-update worker: %s", e)
            sleep_seconds = 3600
        await asyncio.sleep(sleep_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────
    log.info("=== mView Sentinel starting up ===")

    # Initialize shared HTTP client for proxying and external services
    limits = httpx.Limits(max_keepalive_connections=50, max_connections=200)
    app.state.http_client = httpx.AsyncClient(timeout=15.0, limits=limits)

    # DB tables
    from sqlalchemy import text, select
    async with engine.begin() as conn:
        if engine.url.get_backend_name().startswith("postgresql"):
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text(
            'CREATE INDEX IF NOT EXISTS ix_semantic_events_camera_ts '
            'ON semantic_events (camera_id, "timestamp" DESC)'
        ))

    # Seed a default admin user the first time the database starts.
    from api.database import async_session_maker as AsyncSessionLocal
    from api.routers.auth import get_password_hash
    async with AsyncSessionLocal() as db:
        existing_users = await db.execute(select(User.id).limit(1))
        if existing_users.scalar_one_or_none() is None:
            admin_password = os.getenv("ADMIN_PASSWORD", settings.default_admin_password)
            db.add(User(
                username=settings.default_admin_username,
                hashed_password=get_password_hash(admin_password),
                role="admin",
                permissions=["live", "playback", "events", "settings", "operations"],
            ))
            await db.commit()
            log.info("Seeded default admin user.")

    # Check frontend
    dist = Path(__file__).parent.parent / "web" / "dist"
    if dist.exists():
        idx = dist / "index.html"
        log.info(f"Frontend dist: FOUND at {dist}  (index.html={'yes' if idx.exists() else 'MISSING'})")
    else:
        log.warning(f"Frontend dist: NOT FOUND at {dist} — API-only mode")

    # Start recorders for all cameras
    from api.models.camera import Camera
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Camera))
        cams = result.scalars().all()
    await recorder_manager.sync_cameras(cams)
    log.info(f"Recorder started for {len(cams)} camera(s).")

    # Start retention, storage migration, and background workers
    from api.services.storage_tier_migration import storage_migration_worker
    background_tasks = [
        asyncio.create_task(local_snapshot_worker(), name="local-core-snapshot"),
        asyncio.create_task(retention_worker(), name="retention-worker"),
        asyncio.create_task(storage_migration_worker(), name="storage-migration-worker"),
        asyncio.create_task(auto_update_worker(), name="auto-update-worker"),
    ]
    from api.services.event_processor import process_mqtt_events
    background_tasks.append(asyncio.create_task(process_mqtt_events(), name="mqtt-event-processor"))


    try:
        yield
    finally:
        for task in background_tasks:
            task.cancel()
        await asyncio.gather(*background_tasks, return_exceptions=True)

        # ── Shutdown ─────────────────────────────────────────────────────
        recorder_manager.stop_all()
        if hasattr(app.state, "http_client") and app.state.http_client:
            await app.state.http_client.aclose()
        await engine.dispose()
        log.info("Sentinel shutdown complete.")


app = FastAPI(title="mView Sentinel", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_and_security_middleware(request: Request, call_next):
    path = request.url.path

    if request.method == "OPTIONS":
        response = await call_next(request)
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    path_permissions = [
        ("/cameras", {"live", "settings"}),
        ("/recordings-list", {"playback"}),
        ("/recordings", {"playback"}),
        ("/events", {"events"}),
        ("/maps", {"live", "settings"}),
        ("/ops-api", {"operations", "settings"}),
        ("/go2rtc", {"live", "settings"}),
        ("/system/live", {"live", "settings"}),
        ("/system", {"settings"}),
        ("/users", {"settings"}),
        ("/agent", {"operations", "settings"}),
        ("/automations", {"settings"}),
    ]


    required = None
    for prefix, permissions in path_permissions:
        if path.startswith(prefix):
            required = permissions
            break

    # Allow users to change their own password without needing 'settings' permission
    import re as _re
    if request.method == "PATCH" and _re.match(r'^/users/[^/]+/password$', path):
        required = None  # just needs a valid JWT — enforced inside the route handler

    is_loopback = bool(
        request.client
        and request.client.host in ("127.0.0.1", "::1", "localhost")
        and not request.headers.get("X-Forwarded-For")
    )
    is_public = (
        is_loopback or
        path.startswith("/system/health") or
        path.startswith("/auth/login") or
        path.startswith("/static/") or
        path.startswith("/assets/") or
        path in ("/docs", "/redoc", "/openapi.json")
    )
    is_media_token_path = (
        path.startswith("/recordings/") or
        path.startswith("/go2rtc/") or
        path.startswith("/system/") or
        path.endswith("/snapshot") or
        path.endswith("/thumbnail")
    )

    if required and not is_public:
        auth_header = request.headers.get("Authorization")
        token = None
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
        elif is_media_token_path:
            token = request.query_params.get("token")

        if not token:
            return JSONResponse(status_code=401, content={"detail": "Not authenticated"})

        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if not payload.get("sub"):
                return JSONResponse(status_code=401, content={"detail": "Invalid token payload"})
            if payload.get("role") != "admin":
                user_permissions = set(payload.get("permissions") or [])
                if not user_permissions.intersection(required):
                    return JSONResponse(status_code=403, content={"detail": "Permission denied"})
        except JWTError:
            return JSONResponse(status_code=401, content={"detail": "Invalid token"})
            
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# ── API routers ────────────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(cameras.router)
app.include_router(recordings.router)
app.include_router(events.router)
app.include_router(system.router)
app.include_router(users.router)
app.include_router(maps.router)
app.include_router(operations.router)
app.include_router(agent.router)
app.include_router(automations.router)


@app.api_route("/go2rtc/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"])
async def proxy_go2rtc(request: Request, path: str = ""):
    """Proxy go2rtc API & WebRTC signaling directly through the main API port using pooled HTTP client."""
    target_base = settings.go2rtc_url.rstrip("/")
    subpath = path if path.startswith("api/") or not path else f"api/{path}"

    # The go2rtc admin API can register exec:/ffmpeg: sources (host command execution),
    # so only expose the read/stream endpoints the UI needs, never stream management.
    allowed_prefixes = ("api/webrtc", "api/stream.", "api/frame.", "api/hls")
    if ".." in subpath or "//" in subpath or not subpath.startswith(allowed_prefixes):
        raise HTTPException(403, "go2rtc endpoint not permitted")
    if request.method not in ("GET", "POST", "OPTIONS"):
        raise HTTPException(405, "Method not allowed")
    if request.method == "POST" and not subpath.startswith("api/webrtc"):
        raise HTTPException(405, "Method not allowed")

    target_url = f"{target_base}/{subpath}"
    forwarded_query = [(k, v) for k, v in request.query_params.multi_items() if k != "token"]
    if forwarded_query:
        from urllib.parse import urlencode
        target_url = f"{target_url}?{urlencode(forwarded_query)}"

    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "authorization", "cookie")
    }

    try:
        client = getattr(request.app.state, "http_client", None)
        if client is None:
            client = httpx.AsyncClient(timeout=10.0)

        req = client.build_request(
            method=request.method,
            url=target_url,
            headers=headers,
            content=body,
        )
        resp = await client.send(
            req,
            stream=True,
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0),
        )
        return StreamingResponse(
            resp.aiter_bytes(),
            status_code=resp.status_code,
            headers={k: v for k, v in resp.headers.items() if k.lower() not in ("content-length", "content-encoding", "transfer-encoding")},
            # Always release the upstream go2rtc connection when the browser disconnects,
            # otherwise every MJPEG/HLS fallback leaks a pooled connection.
            background=BackgroundTask(resp.aclose),
        )
    except Exception as e:
        raise HTTPException(502, f"go2rtc proxy error: {e}")


def _playback_offset(request: Request) -> float:
    raw = request.query_params.get("t")
    if not raw:
        return 0.0
    try:
        return min(3600.0, max(0.0, float(raw)))
    except ValueError:
        return 0.0


_TRANSCODE_LOCKS: dict[str, asyncio.Lock] = {}


def _transcode_lock(path: str) -> asyncio.Lock:
    lock = _TRANSCODE_LOCKS.get(path)
    if lock is None:
        lock = asyncio.Lock()
        _TRANSCODE_LOCKS[path] = lock
    return lock


async def _build_browser_cache(src: Path, dest: Path) -> None:
    """Write a seekable H.264 copy in the background. Playback does not wait for it."""
    from api.services.recorder import _terminate_process, is_finalized_mp4

    lock = _transcode_lock(str(dest))
    if lock.locked():
        return
    async with lock:
        if dest.exists() and dest.stat().st_size >= 10240 and is_finalized_mp4(dest):
            return
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.part")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-pix_fmt", "yuv420p", "-profile:v", "baseline",
            "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart",
            str(tmp),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await proc.wait()
            if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size >= 10240:
                tmp.replace(dest)
        finally:
            await _terminate_process(proc)
            if tmp.exists() and not dest.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass


async def _iter_transcoded(src: Path, start: float):
    """Stream an H.264 fMP4 that begins at `start` seconds. First bytes are not delayed for a full-file encode."""
    from api.services.recorder import _terminate_process

    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, start):.3f}",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
        "-crf", "28", "-pix_fmt", "yuv420p", "-profile:v", "baseline",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof+separate_moof",
        "-f", "mp4", "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(64 * 1024)
            if not chunk:
                break
            yield chunk
    finally:
        await _terminate_process(proc)


# ── Serve recorded video files ─────────────────────────────────────
RECORDINGS_DIR = Path(settings.recordings_dir).resolve()


@app.get("/recordings/{camera_id}/{filename}")
@app.get("/recordings/{camera_id}/export/{filename}")
async def serve_recording(camera_id: str, filename: str, request: Request):
    hot_dir = Path(settings.recordings_dir).resolve()
    cold_dir = Path(os.getenv("COLD_STORAGE_PATH", "/mnt/archive/mview/recordings")).resolve()
    export_dir = (Path(settings.export_path) if hasattr(settings, "export_path") else Path(settings.storage_path) / "exports").resolve()

    candidates = [
        hot_dir / camera_id / filename,
        cold_dir / camera_id / filename,
        export_dir / filename,
    ]

    fp = None
    for candidate in candidates:
        resolved = candidate.resolve()
        if any(base in resolved.parents for base in (hot_dir, cold_dir, export_dir)):
            if resolved.exists() and resolved.is_file():
                fp = resolved
                break

    if not fp:
        raise HTTPException(404, "Recording not found")

    file_size = fp.stat().st_size
    from api.services.recorder import is_finalized_cached, is_finalized_mp4, needs_browser_transcode
    if file_size < 10240 or not is_finalized_cached(str(fp), fp.stat()):
        raise HTTPException(409, "Recording segment is unfinalized or in-progress")

    # H.265 segments are not playable in Chrome. Serve a finished H.264 cache when
    # one exists. Otherwise start that cache in the background and stream from the
    # requested offset immediately, so the request is not held for a full transcode.
    if needs_browser_transcode(fp, file_size):
        cache_dir = Path(settings.storage_path) / "transcoded_cache" / camera_id
        cached_fp = cache_dir / filename
        if cached_fp.exists() and cached_fp.stat().st_size >= 10240 and is_finalized_mp4(cached_fp):
            fp = cached_fp
            file_size = fp.stat().st_size
        else:
            asyncio.create_task(_build_browser_cache(fp, cached_fp))
            return StreamingResponse(
                _iter_transcoded(fp, _playback_offset(request)),
                media_type="video/mp4",
                headers={"Cache-Control": "no-store", "Accept-Ranges": "none"},
            )

    range_header = request.headers.get("range")
    if range_header:
        start = 0
        end = file_size - 1
        try:
            requested = range_header.replace("bytes=", "", 1)
            start_text, end_text = requested.split("-", 1)
            if start_text:
                start = int(start_text)
            if end_text:
                end = min(int(end_text), file_size - 1)
        except ValueError:
            raise HTTPException(416, "Invalid range")
        if start > end or start >= file_size:
            raise HTTPException(416, "Requested range not satisfiable")

        async def async_iter_file():
            async with aiofiles.open(fp, "rb") as fh:
                await fh.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = await fh.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            async_iter_file(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(end - start + 1),
            },
        )
    return FileResponse(str(fp), media_type="video/mp4",
                        headers={"Accept-Ranges": "bytes"})


# ── Frontend SPA — ALWAYS registered, handles missing build gracefully ──
DIST = Path(__file__).parent.parent / "web" / "dist"
INDEX = DIST / "index.html"

# Mount /assets only if the built assets folder exists
_assets = DIST / "assets"
if _assets.exists():
    app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")

app.mount("/static/maps", StaticFiles(directory=maps.UPLOAD_DIR), name="maps")

FALLBACK_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>mView Sentinel — Building…</title>
<style>
  body { background: #0d1520; color: #00f0d4; font-family: monospace;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; flex-direction:column; gap:16px; }
  h1   { font-size:1.4rem; letter-spacing:2px; }
  p    { color:#7e90a8; font-size:0.9rem; max-width:480px; text-align:center; line-height:1.6; }
  code { background:rgba(0,240,212,.1); border:1px solid rgba(0,240,212,.25);
         padding:8px 16px; border-radius:8px; display:block; margin-top:8px; }
</style>
</head>
<body>
  <h1>⬡ mView Sentinel</h1>
  <p>The API is running but the frontend was not compiled into this image.<br>
     Check your Docker build logs, then redeploy:</p>
  <code>cd /opt/mview-sentinel && docker compose up -d --build</code>
  <p style="margin-top:24px">API health: <a style="color:#00f0d4" href="/system/health">/system/health</a></p>
</body>
</html>"""


@app.get("/{full_path:path}")
async def serve_spa(request: Request, full_path: str):
    """Catch-all: serve the React SPA, or a useful fallback if not built yet."""
    # Try to serve a real file from dist first
    if DIST.exists() and full_path:
        candidate = DIST / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))

    # Serve index.html for all SPA routes
    if INDEX.exists():
        return FileResponse(
            str(INDEX),
            headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
        )

    # Graceful fallback if the frontend was never built
    return HTMLResponse(FALLBACK_HTML, status_code=200)

