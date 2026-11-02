#!/bin/sh
# Build a Mosquitto password file from the shared secret, then start the broker.
set -eu
SECRETS="${SENTINEL_SECRETS_DIR:-/run/sentinel/secrets}"
PASS=$(cat "$SECRETS/mqtt_password")
mkdir -p /mosquitto/data
mosquitto_passwd -b -c /mosquitto/data/passwd sentinel "$PASS"
chown mosquitto:mosquitto /mosquitto/data/passwd || true
exec mosquitto -c /mosquitto/config/mosquitto.conf
