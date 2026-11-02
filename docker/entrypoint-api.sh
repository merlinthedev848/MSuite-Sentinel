#!/bin/sh
# Load the shared secret files, then start the API.
set -eu
SECRETS="${SENTINEL_SECRETS_DIR:-/run/sentinel/secrets}"
export SENTINEL_SECRETS_DIR="$SECRETS"

read_file() {
  if [ -s "$1" ]; then
    cat "$1"
  fi
}

if [ -z "${DATABASE_URL:-}" ]; then
  PW=$(read_file "$SECRETS/postgres_password" || true)
  if [ -n "${PW:-}" ]; then
    export DATABASE_URL="postgresql+asyncpg://sentinel:${PW}@127.0.0.1:5432/sentinelnvr"
  fi
fi

if [ -z "${JWT_SECRET:-}" ]; then
  SECRET=$(read_file "$SECRETS/jwt_secret" || true)
  if [ -n "${SECRET:-}" ]; then
    export JWT_SECRET="$SECRET"
  fi
fi

if [ -z "${SENTINEL_SERVICE_TOKEN:-}" ]; then
  TOKEN=$(read_file "$SECRETS/service_token" || true)
  if [ -n "${TOKEN:-}" ]; then
    export SENTINEL_SERVICE_TOKEN="$TOKEN"
  fi
fi

if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN=$(read_file "$SECRETS/admin_password" || true)
  if [ -n "${ADMIN:-}" ]; then
    export ADMIN_PASSWORD="$ADMIN"
  fi
fi

if [ -z "${MQTT_PASSWORD:-}" ]; then
  MPW=$(read_file "$SECRETS/mqtt_password" || true)
  if [ -n "${MPW:-}" ]; then
    export MQTT_USERNAME="${MQTT_USERNAME:-sentinel}"
    export MQTT_PASSWORD="$MPW"
  fi
fi

if [ -z "${GO2RTC_URL:-}" ]; then
  GPW=$(read_file "$SECRETS/go2rtc_password" || true)
  if [ -n "${GPW:-}" ]; then
    export GO2RTC_URL="http://sentinel:${GPW}@127.0.0.1:1984"
  fi
fi

echo "sentinel-api entrypoint: launching $*" >&2
exec "$@"
