"""Connect to Postgres without taking the API down.

Uvicorn opens port 8000 only after the lifespan finishes. A password error or a
refused connection used to raise out of startup, the process exited, and the
dashboard port stayed closed.

Upgraded installs kept a Postgres data directory created with the old compose
password ``sentinel`` while the API started using the generated password file.
This module aligns that local role to the generated password, retries a down
database, and lets the caller keep the process alive if the database still
cannot be reached.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import unquote, urlparse

log = logging.getLogger("sentinel.db")

LEGACY_LOCAL_PASSWORD = "sentinel"
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def split_database_url(database_url: str) -> dict[str, Any] | None:
    """Parse a SQLAlchemy Postgres URL. The password is not logged by callers."""
    if not database_url or not database_url.startswith("postgresql"):
        return None
    parsed = urlparse(database_url.replace("postgresql+asyncpg://", "postgresql://", 1))
    if not parsed.hostname or not parsed.username:
        return None
    return {
        "user": unquote(parsed.username),
        "password": unquote(parsed.password or ""),
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "database": parsed.path.lstrip("/"),
    }


def is_auth_failure(exc: BaseException) -> bool:
    blob = f"{type(exc).__name__} {exc}".lower()
    return "password authentication failed" in blob or "invalidpassword" in blob


def is_connection_failure(exc: BaseException) -> bool:
    blob = f"{type(exc).__name__} {exc}".lower()
    needles = (
        "connection refused",
        "could not connect",
        "timeout",
        "timed out",
        "temporarily unavailable",
        "name or service not known",
        "temporary failure in name resolution",
        "network is unreachable",
        "connection reset",
    )
    return any(needle in blob for needle in needles)


def legacy_password_can_replace(parts: dict[str, Any]) -> bool:
    """True only for this appliance's local sentinel database."""
    password = str(parts.get("password") or "")
    return (
        parts.get("user") == "sentinel"
        and parts.get("database") == "sentinelnvr"
        and str(parts.get("host") or "").lower() in _LOCAL_HOSTS
        and len(password) >= 8
        and password != LEGACY_LOCAL_PASSWORD
    )


async def repair_legacy_local_password(database_url: str) -> bool:
    """Point the local sentinel role at the generated password.

    The historical compose file initialized Postgres with the password
    ``sentinel``. The generated password is already the one the API is using.
    This does not accept ``sentinel`` as an application login.
    """
    parts = split_database_url(database_url)
    if parts is None or not legacy_password_can_replace(parts):
        return False
    try:
        import asyncpg
    except ImportError:
        log.warning("asyncpg is not installed; the local Postgres password was not updated")
        return False
    try:
        conn = await asyncpg.connect(
            user=parts["user"],
            password=LEGACY_LOCAL_PASSWORD,
            host="127.0.0.1",
            port=int(parts["port"]),
            database=parts["database"],
            timeout=5,
        )
    except Exception as exc:
        log.warning("The previous local Postgres password was not accepted (%s)", type(exc).__name__)
        return False
    try:
        escaped = str(parts["password"]).replace("'", "''")
        await conn.execute(f"ALTER USER sentinel WITH PASSWORD '{escaped}'")
    finally:
        await conn.close()
    log.warning("Updated the local Postgres role to the generated password.")
    return True


async def wait_for_database(engine: Any, database_url: str) -> None:
    """Return once ``SELECT 1`` works. Retry a refused connection. Repair one old password."""
    from sqlalchemy import text

    delay = 1
    last: Exception | None = None
    for attempt in range(1, 16):
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            if attempt > 1:
                log.info("Database accepted the connection on attempt %s", attempt)
            return
        except Exception as exc:
            last = exc
            if is_auth_failure(exc) and await repair_legacy_local_password(database_url):
                await engine.dispose()
                continue
            if is_auth_failure(exc) or not is_connection_failure(exc) or attempt == 15:
                break
            log.warning(
                "Database is not accepting connections yet (%s). Retry %s/15.",
                type(exc).__name__,
                attempt,
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5)
    if last is None:
        raise RuntimeError("Database connection failed")
    raise last
