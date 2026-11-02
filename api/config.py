"""
SentinelNVR Configuration Module.

Loads configuration from environment variables and an optional sentinel.yml file.
Environment variables take precedence over YAML values.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _load_yaml_config(path: str | None = None) -> dict[str, Any]:
    """Load configuration from a YAML file if it exists."""
    search_paths = [
        path,
        os.environ.get("SENTINEL_CONFIG_FILE"),
        "/etc/sentinel/sentinel.yml",
        "/opt/mview-sentinel/sentinel.yml",
        str(Path.cwd() / "sentinel.yml"),
    ]
    for p in search_paths:
        if p and Path(p).is_file():
            with open(p, "r", encoding="utf-8") as fh:
                data = yaml.safe_load(fh)
                return data if isinstance(data, dict) else {}
    return {}


class Settings(BaseSettings):
    """Application settings loaded from env vars, .env file, and sentinel.yml."""

    model_config = SettingsConfigDict(
        env_prefix="SENTINEL_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Core ────────────────────────────────────────────────────────────
    app_name: str = "SentinelNVR"
    app_version: str = "1.0.0"
    debug: bool = False
    log_level: str = "INFO"
    host: str = "0.0.0.0"
    port: int = 8080
    workers: int = 1

    # ── Database ────────────────────────────────────────────────────────
    database_url: str = Field(
        default="postgresql+asyncpg://sentinel:sentinel@localhost:5432/sentinelnvr",
        validation_alias=AliasChoices("SENTINEL_DATABASE_URL", "DATABASE_URL"),
        description="Async SQLAlchemy database URL",
    )
    db_pool_size: int = 20
    db_max_overflow: int = 10
    db_echo: bool = False

    # ── Redis ───────────────────────────────────────────────────────────
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("SENTINEL_REDIS_URL", "REDIS_URL"),
    )

    # ── MQTT ────────────────────────────────────────────────────────────
    mqtt_broker: str = Field(
        default="localhost",
        validation_alias=AliasChoices("SENTINEL_MQTT_BROKER", "MQTT_BROKER"),
    )
    mqtt_port: int = Field(
        default=1883,
        validation_alias=AliasChoices("SENTINEL_MQTT_PORT", "MQTT_PORT"),
    )
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_client_id: str = "sentinel-api"

    # ── JWT / Auth ──────────────────────────────────────────────────────
    jwt_secret: str = Field(
        default="CHANGE-ME-IN-PRODUCTION-USE-RANDOM-SECRET",
        validation_alias=AliasChoices("SENTINEL_JWT_SECRET", "JWT_SECRET"),
        description="Secret key for JWT signing – MUST be changed in production.",
    )
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = Field(
        default=60 * 24,
        validation_alias=AliasChoices(
            "SENTINEL_JWT_ACCESS_TOKEN_EXPIRE_MINUTES",
            "JWT_ACCESS_TOKEN_EXPIRE_MINUTES",
        ),
    )
    jwt_refresh_token_expire_days: int = 7

    # ── Default Admin ───────────────────────────────────────────────────
    default_admin_username: str = "admin"
    default_admin_password: str = "admin"
    default_admin_email: str = "admin@sentinel.local"

    # ── Storage ─────────────────────────────────────────────────────────
    storage_path: str = Field(
        default="/mnt/storage/mview",
        validation_alias=AliasChoices("SENTINEL_STORAGE_PATH", "STORAGE_PATH"),
    )
    thumbnail_path: str = "/opt/mview-sentinel/thumbnails"
    snapshot_path: str = "/opt/mview-sentinel/snapshots"
    export_path: str = "/opt/mview-sentinel/exports"
    retention_days: int = Field(
        default=30,
        validation_alias=AliasChoices("SENTINEL_RETENTION_DAYS", "RETENTION_DAYS"),
    )
    recordings_dir: str = Field(
        default="/mnt/storage/mview/recordings",
        validation_alias=AliasChoices("SENTINEL_RECORDINGS_DIR", "RECORDINGS_DIR"),
    )
    segment_seconds: int = Field(
        default=60,
        validation_alias=AliasChoices("SENTINEL_SEGMENT_SECONDS", "SEGMENT_SECONDS"),
    )
    record_substream_default: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "SENTINEL_RECORD_SUBSTREAM_DEFAULT",
            "RECORD_SUBSTREAM_DEFAULT",
        ),
    )
    record_video_codec: str = Field(
        default="copy",
        validation_alias=AliasChoices("SENTINEL_RECORD_VIDEO_CODEC", "RECORD_VIDEO_CODEC"),
    )
    record_video_crf: str = Field(
        default="30",
        validation_alias=AliasChoices("SENTINEL_RECORD_VIDEO_CRF", "RECORD_VIDEO_CRF"),
    )
    record_video_preset: str = Field(
        default="veryfast",
        validation_alias=AliasChoices("SENTINEL_RECORD_VIDEO_PRESET", "RECORD_VIDEO_PRESET"),
    )

    # ── go2rtc ──────────────────────────────────────────────────────────
    go2rtc_url: str = Field(
        default="http://localhost:1984",
        validation_alias=AliasChoices("SENTINEL_GO2RTC_URL", "GO2RTC_URL"),
    )
    go2rtc_config_path: str = "/etc/sentinel/go2rtc.yaml"

    # ── ONVIF / Discovery ───────────────────────────────────────────────
    onvif_timeout: int = 5
    discovery_timeout: int = 10
    rtsp_scan_timeout: int = 3
    default_onvif_port: int = 80

    # ── Notification Defaults ───────────────────────────────────────────
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "sentinel@localhost"
    smtp_use_tls: bool = True

    # ── CORS ────────────────────────────────────────────────────────────
    cors_origins: list[str] = ["*"]

    # ── AI Active Operator Settings ─────────────────────────────────────
    ai_provider: str = Field(
        default="local",
        validation_alias=AliasChoices("SENTINEL_AI_PROVIDER", "AI_PROVIDER"),
    )
    gemini_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("SENTINEL_GEMINI_API_KEY", "GEMINI_API_KEY"),
    )
    openai_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("SENTINEL_OPENAI_API_KEY", "OPENAI_API_KEY"),
    )

    # ── Camera YAML config (loaded from sentinel.yml) ───────────────────
    cameras_config: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("log_level")
    @classmethod
    def _upper_log_level(cls, v: str) -> str:
        return v.upper()

    def load_yaml_cameras(self) -> list[dict[str, Any]]:
        """Return camera definitions from sentinel.yml if present."""
        cfg = _load_yaml_config()
        return cfg.get("cameras", [])


# Singleton settings instance
settings = Settings()
