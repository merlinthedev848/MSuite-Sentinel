#!/usr/bin/env python3
"""Check the default-install fixes against a temporary SQLite database.

The script sets its environment before importing the API. It does not start Docker.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = Path("/tmp/sentinel-audit-verify")
SECRETS = BASE / "secrets"
if BASE.exists():
    import shutil
    shutil.rmtree(BASE)
BASE.mkdir(parents=True)
os.environ["SENTINEL_SECRETS_DIR"] = str(SECRETS)
os.environ["SENTINEL_STORAGE_PATH"] = str(BASE / "storage")
os.environ["STORAGE_PATH"] = str(BASE / "storage")
os.environ["SENTINEL_RECORDINGS_DIR"] = str(BASE / "recordings")
os.environ["RECORDINGS_DIR"] = str(BASE / "recordings")
os.environ["SENTINEL_EXPORT_PATH"] = str(BASE / "exports")
os.environ["SENTINEL_THUMBNAIL_PATH"] = str(BASE / "thumbnails")
os.environ["SENTINEL_SNAPSHOT_PATH"] = str(BASE / "snapshots")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{BASE / 'sentinel.db'}"
os.environ["SENTINEL_CONFIG_FILE"] = str(ROOT / "sentinel.yml")
os.environ.pop("JWT_SECRET", None)
os.environ.pop("SENTINEL_JWT_SECRET", None)
os.environ.pop("COLD_STORAGE_PATH", None)
os.environ.pop("RETENTION_DAYS", None)
os.environ.pop("SENTINEL_RETENTION_DAYS", None)
os.environ.pop("ADMIN_PASSWORD", None)
sys.path[:0] = ["/tmp/pylibs", str(ROOT)]

from fastapi.testclient import TestClient
from jose import jwt

from api.config import settings
from api.main import app
from api.services.event_processor import _rule_matches
from api.services.recorder import purge_old_recordings
from api.services.storage_tier_migration import StorageTierMigration

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS" if ok else "FAIL"), name, detail)
    if not ok:
        failures.append(f"{name}: {detail}")


check("yaml retention applied", settings.retention_days == 14, str(settings.retention_days))
check("yaml mqtt broker applied", settings.mqtt_broker == "127.0.0.1", settings.mqtt_broker)
check("public jwt replaced", "CHANGE-ME" not in settings.jwt_secret and "super-secret" not in settings.jwt_secret and len(settings.jwt_secret) >= 24)
check("service token generated", len(settings.service_token) >= 24)

migration = StorageTierMigration()
check("cold storage disabled by default", migration.cold_storage_dir is None)
check("cold migration does not create /mnt/archive", migration.run_migration().get("enabled") is False and not Path("/mnt/archive/mview/recordings").exists())

check("person rule ignores cars", _rule_matches("person_detected", "car", []) is False)
check("person rule matches person", _rule_matches("person_detected", "person", []) is True)
check("empty object list does not match", _rule_matches("object", "truck", []) is False)

semantic_source = (ROOT / "detector" / "semantic_search.py").read_text()
alpr_source = (ROOT / "detector" / "alpr.py").read_text()
face_source = (ROOT / "detector" / "face_recognition.py").read_text()
check("semantic embed is empty", "np.random" not in semantic_source and "return None" in semantic_source)
check("alpr does not invent a plate", "ABC 123" not in alpr_source and "return None" in alpr_source)
check("face recognition does not invent a face", "np.random" not in face_source and "return []" in face_source)

compose = (ROOT / "docker-compose.yml").read_text()
check("compose has no docker socket", "/var/run/docker.sock" not in compose)
check("compose does not publish redis", "6379:6379" not in compose and "redis:" not in compose)
check("postgres is localhost only", '127.0.0.1:5432:5432' in compose)
check("mqtt is localhost only", '127.0.0.1:1883:1883' in compose)
check("apparmor unconfined removed", "apparmor=unconfined" not in compose)
mosquitto = (ROOT / "config" / "mosquitto.conf").read_text()
check("mqtt anonymous disabled", "allow_anonymous false" in mosquitto and "persistence true" in mosquitto)
go2rtc = (ROOT / "go2rtc.yaml").read_text()
check("go2rtc listens on localhost", "127.0.0.1:1984" in go2rtc and 'listen: ":1984"' not in go2rtc)
auth_source = (ROOT / "api" / "routers" / "auth.py").read_text()
check("admin backdoor removed", 'password in ("admin"' not in auth_source and "is_loopback" not in (ROOT / "api" / "main.py").read_text())
system_source = (ROOT / "api" / "routers" / "system.py").read_text()
check("updater cannot reset git", "reset --hard" not in system_source and "docker compose" not in system_source)

with TestClient(app, client=("127.0.0.1", 50000)) as client:
    check("openapi hidden", client.get("/openapi.json").status_code == 404)
    check("loopback cameras require auth", client.get("/cameras").status_code == 401)
    check("floorplans require auth", client.get("/static/maps/floor.png").status_code == 401)
    check("admin/admin rejected", client.post("/auth/login", data={"username": "admin", "password": "admin"}).status_code == 401)
    password = (SECRETS / "admin_password").read_text().strip()
    login = client.post("/auth/login", data={"username": "admin", "password": password})
    check("generated admin password works", login.status_code == 200, login.text[:180])
    token = login.json()["access_token"]
    admin = {"Authorization": f"Bearer {token}"}
    me = client.get("/auth/me")
    check("cookie session identifies the user", me.status_code == 200 and me.json().get("username") == "admin", me.text[:180])
    cookie_list = client.get("/cameras")
    check("cookie session lists cameras", cookie_list.status_code == 200, cookie_list.text[:180])
    query_token = client.get("/cameras", params={"token": token})
    check("query token rejected", query_token.status_code == 401 and "not accepted" in query_token.text, query_token.text[:180])
    logged_out = client.post("/auth/logout")
    check("logout clears the cookie", logged_out.status_code == 200 and client.get("/cameras").status_code == 401)
    client.cookies.set("sentinel_session", token)
    forged = jwt.encode(
        {"sub": "admin", "role": "admin", "permissions": ["settings"], "ver": 0},
        "CHANGE-ME-IN-PRODUCTION-USE-RANDOM-SECRET",
        algorithm="HS256",
    )
    check("forged public jwt rejected", client.get("/cameras", headers={"Authorization": f"Bearer {forged}"}).status_code == 401)
    health = client.get("/system/health").json()
    check("health is degraded without mqtt and go2rtc", health.get("status") == "degraded" and health.get("database_connected") is True, str({k: health.get(k) for k in ("status", "database_connected", "mqtt_connected", "go2rtc_active", "record_codec")}))
    config = client.get("/system/config", headers=admin).json()
    check("config retention matches runtime", config.get("retention_days") == 14, str(config.get("retention_days")))
    created = client.post("/cameras", headers=admin, json={
        "name": "Gate",
        "rtsp_url_main": "rtsp://operator:s3cret@192.168.1.20:554/main",
        "onvif_password": "s3cret",
        "enabled": True,
    })
    check("admin can create camera", created.status_code == 201, created.text[:180])
    body = created.json()
    check("settings user receives the password", body.get("onvif_password") == "s3cret" and "s3cret" in (body.get("rtsp_url_main") or ""))
    viewer = client.post("/users", headers=admin, json={
        "username": "viewer",
        "password": "viewer-pass",
        "role": "viewer",
        "permissions": ["live"],
    })
    check("viewer created", viewer.status_code == 201, viewer.text[:180])
    viewer_login = client.post("/auth/login", data={"username": "viewer", "password": "viewer-pass"})
    viewer_headers = {"Authorization": f"Bearer {viewer_login.json()['access_token']}"}
    listed = client.get("/cameras", headers=viewer_headers).json()
    listed_text = str(listed)
    check("live user does not receive the password", "s3cret" not in listed_text and "***" in listed_text, listed_text[:300])
    service = client.get("/cameras", headers={"Authorization": f"Bearer {settings.service_token}"})
    check("service token can list cameras", service.status_code == 200 and "s3cret" not in service.text)
    check("service token cannot change settings", client.get("/system/config", headers={"Authorization": f"Bearer {settings.service_token}"}).status_code == 403)
    changed = client.patch(f"/users/{login.json()['user']['id']}/password", headers=admin, json={"new_password": "next-password-1"})
    check("password change", changed.status_code == 200, changed.text[:180])
    check("old token revoked", client.get("/users", headers=admin).status_code == 401)
    relogin = client.post("/auth/login", data={"username": "admin", "password": "next-password-1"})
    check("new password works", relogin.status_code == 200)
    check("old password rejected", client.post("/auth/login", data={"username": "admin", "password": password}).status_code == 401)
    admin = {"Authorization": f"Bearer {relogin.json()['access_token']}"}
    update = client.post("/system/updates/install", headers=admin)
    check("unsigned update refused", update.status_code == 400 and "git reset" not in update.text.lower())
    cam_id = body["id"]
    clip = Path(settings.recordings_dir) / cam_id / "2020-01-01_00-00-00.mp4"
    clip.parent.mkdir(parents=True, exist_ok=True)
    clip.write_bytes(b"\x00" * 8000 + b"ftypmoov" + b"\x00" * 8000)
    exported = client.post("/recordings-list/export", headers=admin, json={
        "camera_id": cam_id,
        "start_time": "2026-11-02T10:00:00Z",
        "end_time": "2026-11-02T10:05:00Z",
    })
    check("export refuses a range with no overlap", exported.status_code == 404, exported.text[:180])
    cold = BASE / "cold"
    old = cold / cam_id / "2019-01-01_00-00-00.mp4"
    old.parent.mkdir(parents=True)
    old.write_bytes(b"cold")
    os.utime(old, (time.time() - 40 * 86400, time.time() - 40 * 86400))
    os.environ["COLD_STORAGE_PATH"] = str(cold)
    purge_old_recordings(14)
    check("retention deletes expired cold files", not old.exists())

import asyncio
import sqlite3
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from api.migrations import apply_migrations

async def _check_legacy_migration() -> tuple[list[str], list[str]]:
    legacy = create_async_engine(f"sqlite+aiosqlite:///{BASE / 'legacy.db'}")
    async with legacy.begin() as conn:
        await conn.execute(text("CREATE TABLE users (id VARCHAR PRIMARY KEY, username VARCHAR)"))
        await conn.execute(text(
            'CREATE TABLE semantic_events (id VARCHAR PRIMARY KEY, camera_id VARCHAR, "timestamp" DATETIME)'
        ))
        first = await apply_migrations(conn)
        second = await apply_migrations(conn)
    await legacy.dispose()
    return first, second

legacy_first, legacy_second = asyncio.run(_check_legacy_migration())
check(
    "legacy schema records migrations",
    legacy_first == ["0001_users_token_version", "0002_semantic_events_camera_ts"] and legacy_second == [],
    str(legacy_first),
)
legacy_columns = {row[1] for row in sqlite3.connect(BASE / "legacy.db").execute("PRAGMA table_info(users)")}
check("legacy users table gains token_version", "token_version" in legacy_columns, str(sorted(legacy_columns)))

migration_rows = {row[0] for row in sqlite3.connect(BASE / "sentinel.db").execute("SELECT id FROM schema_migrations")}
check(
    "schema migrations recorded",
    {"0001_users_token_version", "0002_semantic_events_camera_ts"} <= migration_rows,
    str(sorted(migration_rows)),
)
main_source = (ROOT / "api" / "main.py").read_text()
check("recording server has no default archive path", "/mnt/archive" not in main_source)
web_hits = []
for source_file in (ROOT / "web" / "src").rglob("*"):
    if source_file.suffix not in {".ts", ".tsx"}:
        continue
    text = source_file.read_text()
    if "localStorage.getItem('mview_token'" in text or "localStorage.setItem('mview_token'" in text or "?token=" in text:
        web_hits.append(str(source_file.relative_to(ROOT)))
check("dashboard does not keep the session token", not web_hits, ", ".join(web_hits))

if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nAll audit checks passed")
