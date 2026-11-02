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
    use_ipv4_loopback,
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
    assert is_connection_failure(TimeoutError())
    rewritten = use_ipv4_loopback(
        "postgresql+asyncpg://sentinel:generated-secret-value@localhost:5432/sentinelnvr"
    )
    assert "@127.0.0.1:5432/" in rewritten
    assert "generated-secret-value" in rewritten
    assert use_ipv4_loopback(url) == url

    root = Path(__file__).resolve().parents[1]
    source = (root / "api/main.py").read_text()
    lifespan = source.split("async def lifespan", 1)[1].split("\napp = FastAPI", 1)[0]
    assert lifespan.index("async def _bring_up") < lifespan.index("await wait_for_database")
    assert lifespan.index("create_task(_bring_up()") < lifespan.index("\n        yield")
    assert "await wait_for_database" in lifespan.split("async def _bring_up", 1)[1]
    compose = (root / "docker-compose.yml").read_text()
    assert 'command: ["python", "/serve_api.py"]' in compose
    assert "--workers" not in compose.split("container_name: sentinel-api", 1)[1].split("container_name:", 1)[0]

    import importlib.util
    spec = importlib.util.spec_from_file_location("serve_api", root / "docker/serve_api.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sock = module.listening_socket("127.0.0.1", 0)
    try:
        probe = __import__("socket").create_connection(("127.0.0.1", sock.getsockname()[1]), timeout=1)
        probe.close()
    finally:
        sock.close()
    print("db ready checks ok")


if __name__ == "__main__":
    main()
