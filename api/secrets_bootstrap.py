"""Create durable random secrets when the configured values are public placeholders.

The module only uses the process environment and the filesystem. It must not
import application settings, because settings are built from the values here.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

WEAK_SECRETS = {
    "",
    "change-me-in-production-use-random-secret",
    "super-secret-mview-key",
    "admin",
    "password",
    "sentinel",
    "mview",
}


def is_weak_secret(value: str | None, *, min_length: int = 24) -> bool:
    if value is None:
        return True
    text = value.strip()
    if len(text) < min_length:
        return True
    return text.lower() in WEAK_SECRETS


def secrets_dir() -> Path:
    """Return a writable directory for generated secrets."""
    candidates: list[Path] = []
    explicit = os.environ.get("SENTINEL_SECRETS_DIR", "").strip()
    if explicit:
        candidates.append(Path(explicit))
    for key in ("SENTINEL_STORAGE_PATH", "STORAGE_PATH"):
        storage = os.environ.get(key, "").strip()
        if storage:
            candidates.append(Path(storage) / "secrets")
    candidates.append(Path("/opt/mview-sentinel/secrets"))
    candidates.append(Path("/tmp/sentinel-secrets"))

    last_error: OSError | None = None
    for path in candidates:
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return path
        except OSError as exc:
            last_error = exc
            continue
    raise OSError(f"No writable secrets directory: {last_error}")


def read_secret_file(name: str) -> str:
    path = secrets_dir() / name
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _write_secret(name: str, value: str) -> str:
    path = secrets_dir() / name
    path.write_text(value + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return value


def read_or_create(name: str, nbytes: int = 32) -> str:
    existing = read_secret_file(name)
    if existing and not is_weak_secret(existing):
        return existing
    return _write_secret(name, secrets.token_urlsafe(nbytes))


def ensure_jwt_secret(configured: str | None) -> str:
    if not is_weak_secret(configured):
        return configured.strip()
    return read_or_create("jwt_secret", 48)


def ensure_service_token(configured: str | None) -> str:
    if not is_weak_secret(configured):
        return configured.strip()
    return read_or_create("service_token", 32)


def ensure_admin_password() -> tuple[str, Path, bool]:
    """Return the first-boot admin password, its file, and whether it was just created.

    ADMIN_PASSWORD is honored only when it is not a well-known default.
    The password ``admin`` is never accepted.
    """
    explicit = os.environ.get("ADMIN_PASSWORD", "").strip()
    path = secrets_dir() / "admin_password"
    if explicit and explicit.lower() not in WEAK_SECRETS and len(explicit) >= 8:
        created = not path.is_file()
        if created or path.read_text(encoding="utf-8").strip() != explicit:
            _write_secret("admin_password", explicit)
            created = True
        return explicit, path, created

    if path.is_file():
        existing = path.read_text(encoding="utf-8").strip()
        if existing and existing.lower() not in WEAK_SECRETS and len(existing) >= 8:
            return existing, path, False
    value = secrets.token_urlsafe(18)
    _write_secret("admin_password", value)
    return value, path, True
