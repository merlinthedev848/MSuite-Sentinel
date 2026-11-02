#!/bin/sh
# Load the same service token and MQTT password the API uses.
set -eu
SECRETS="${SENTINEL_SECRETS_DIR:-/run/sentinel/secrets}"
if [ -z "${SENTINEL_SERVICE_TOKEN:-}" ] && [ -s "$SECRETS/service_token" ]; then
  export SENTINEL_SERVICE_TOKEN=$(cat "$SECRETS/service_token")
fi
if [ -z "${MQTT_PASSWORD:-}" ] && [ -s "$SECRETS/mqtt_password" ]; then
  export MQTT_USERNAME="${MQTT_USERNAME:-sentinel}"
  export MQTT_PASSWORD=$(cat "$SECRETS/mqtt_password")
fi
export API_URL="${API_URL:-http://127.0.0.1:8000/cameras}"
exec python detector.py
