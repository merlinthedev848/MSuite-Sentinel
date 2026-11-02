#!/usr/bin/env python3
"""Stdlib checks for the startup database guard. No server and no Docker."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.db_ready import (  # noqa: E402
    is_auth_failure,
    is_connection_failure,
    legacy_password_can_replace,
    split_database_url,
)


def main() -> None:
    url = "postgresql+asyncpg://sentinel:generated-secret-value@127.0.0.1:5432/sentinelnvr"
    parts = split_database_url(url)
    assert parts is not None
    assert parts["user"] == "sentinel"
    assert parts["password"] == "generated-secret-value"
    assert parts["host"] == "127.0.0.1"
    assert parts["database"] == "sentinelnvr"
    assert legacy_password_can_replace(parts)

    encoded = split_database_url(
        "postgresql+asyncpg://sentinel:p%40ssword-value@localhost:5432/sentinelnvr"
    )
    assert encoded is not None
    assert encoded["password"] == "p@ssword-value"
    assert legacy_password_can_replace(encoded)

    current = dict(parts)
    current["password"] = "sentinel"
    assert not legacy_password_can_replace(current)
    remote = dict(parts)
    remote["host"] = "10.1.1.5"
    assert not legacy_password_can_replace(remote)
    other_db = dict(parts)
    other_db["database"] = "postgres"
    assert not legacy_password_can_replace(other_db)

    assert is_auth_failure(Exception("password authentication failed for user sentinel"))
    assert not is_auth_failure(ConnectionRefusedError("[Errno 111] Connection refused"))
    assert is_connection_failure(ConnectionRefusedError("[Errno 111] Connection refused"))
    assert is_connection_failure(TimeoutError("connection timed out"))
    assert not is_connection_failure(Exception("password authentication failed"))
    assert split_database_url("sqlite+aiosqlite:///tmp/sentinel.db") is None

    source = Path(__file__).resolve().parents[1].joinpath("api/main.py").read_text()
    assert "wait_for_database" in source
    assert "API startup finished. Serving the dashboard on http://0.0.0.0:8000/" in source
    print("db ready checks ok")


if __name__ == "__main__":
    main()
