"""Ordered schema migrations.

Fresh databases are created from the current models, then every migration is
recorded. Existing databases run only the migrations that are not yet recorded.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection


def _add_token_version(sync_conn) -> None:
    inspector = inspect(sync_conn)
    if "users" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "token_version" in columns:
        return
    sync_conn.execute(text(
        "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0"
    ))


async def _migration_token_version(conn: AsyncConnection) -> None:
    await conn.run_sync(_add_token_version)


async def _migration_event_index(conn: AsyncConnection) -> None:
    await conn.execute(text(
        'CREATE INDEX IF NOT EXISTS ix_semantic_events_camera_ts '
        'ON semantic_events (camera_id, "timestamp" DESC)'
    ))


MIGRATIONS: list[tuple[str, object]] = [
    ("0001_users_token_version", _migration_token_version),
    ("0002_semantic_events_camera_ts", _migration_event_index),
]


async def apply_migrations(conn: AsyncConnection) -> list[str]:
    """Apply pending migrations and return the ids that ran."""
    await conn.execute(text(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id VARCHAR PRIMARY KEY,
            applied_at VARCHAR NOT NULL
        )
        """
    ))
    recorded = await conn.execute(text("SELECT id FROM schema_migrations"))
    applied = {row[0] for row in recorded}
    ran: list[str] = []
    for migration_id, fn in MIGRATIONS:
        if migration_id in applied:
            continue
        await fn(conn)
        await conn.execute(
            text("INSERT INTO schema_migrations (id, applied_at) VALUES (:id, :applied_at)"),
            {"id": migration_id, "applied_at": datetime.now(timezone.utc).isoformat()},
        )
        ran.append(migration_id)
    return ran
