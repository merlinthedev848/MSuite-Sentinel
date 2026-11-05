#!/bin/sh
# Create the passwords and the go2rtc config the stack shares.
# Existing files are left in place so a restart does not rotate credentials.
set -eu
umask 077
DIR=/secrets
mkdir -p "$DIR"

rand() {
  head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-32
}

[ -s "$DIR/postgres_password" ] || rand > "$DIR/postgres_password"
[ -s "$DIR/mqtt_password" ] || rand > "$DIR/mqtt_password"
[ -s "$DIR/jwt_secret" ] || rand > "$DIR/jwt_secret"
[ -s "$DIR/service_token" ] || rand > "$DIR/service_token"
[ -s "$DIR/go2rtc_password" ] || rand > "$DIR/go2rtc_password"
[ -s "$DIR/admin_password" ] || rand > "$DIR/admin_password"

GO2RTC_PASSWORD=$(cat "$DIR/go2rtc_password")
cat > "$DIR/go2rtc.yaml" <<EOF
api:
  listen: "127.0.0.1:1984"
  username: "sentinel"
  password: "${GO2RTC_PASSWORD}"
  origin: "http://127.0.0.1:8000"

webrtc:
  listen: "127.0.0.1:8555"

rtsp:
  listen: "127.0.0.1:8554"

ffmpeg:
  bin: "ffmpeg"

streams: {}
EOF
chmod 600 "$DIR"/* || true
echo "Sentinel secrets are ready in the shared volume."
