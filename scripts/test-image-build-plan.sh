#!/bin/bash
# Planner checks. No Docker and no network.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLAN=$ROOT/scripts/image-build-plan.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/tree/api" "$TMP/tree/web/dist" "$TMP/tree/docker" "$TMP/tree/detector" "$TMP/tree/vendor"
printf 'ignore\n' > "$TMP/tree/.dockerignore"
printf 'api\n' > "$TMP/tree/api/Dockerfile"
printf 'fastapi\n' > "$TMP/tree/api/requirements.txt"
printf 'print("api")\n' > "$TMP/tree/api/main.py"
printf '<html></html>\n' > "$TMP/tree/web/dist/index.html"
printf '#!/bin/sh\n' > "$TMP/tree/docker/entrypoint-api.sh"
printf 'detector\n' > "$TMP/tree/detector/Dockerfile"
printf 'ultralytics\n' > "$TMP/tree/detector/requirements.txt"
printf 'print("det")\n' > "$TMP/tree/detector/detector.py"
printf 'vendor\n' > "$TMP/tree/vendor/unused.c"
mkdir -p "$TMP/tree/api/__pycache__"
printf 'junk\n' > "$TMP/tree/api/__pycache__/main.pyc"

plan() {
    bash "$PLAN" --root "$TMP/tree" --stamp "$TMP/stamps" --api-present "$1" --detector-present "$2"
}

# No stamp and no images: both build. Cache files must not affect the hash.
first=$(plan 0 0)
printf '%s\n' "$first" | grep -q '^build api '
printf '%s\n' "$first" | grep -q '^build detector '
api_hash=$(printf '%s\n' "$first" | awk '$1=="build" && $2=="api" { print $3 }')
detector_hash=$(printf '%s\n' "$first" | awk '$1=="build" && $2=="detector" { print $3 }')
test "${#api_hash}" -eq 64
test "${#detector_hash}" -eq 64

# Same tree again, including a pyc change and a vendor change: hashes stay put.
printf 'different\n' > "$TMP/tree/api/__pycache__/main.pyc"
printf 'other\n' > "$TMP/tree/vendor/unused.c"
second=$(plan 0 0)
test "$second" = "$first"

# Record a successful build. Both images present: skip.
printf 'api %s\ndetector %s\n' "$api_hash" "$detector_hash" > "$TMP/stamps"
skipped=$(plan 1 1)
printf '%s\n' "$skipped" | grep -q "^skip api $api_hash$"
printf '%s\n' "$skipped" | grep -q "^skip detector $detector_hash$"

# A matching stamp with a deleted image still builds that image only.
missing=$(plan 0 1)
printf '%s\n' "$missing" | grep -q "^build api $api_hash$"
printf '%s\n' "$missing" | grep -q "^skip detector $detector_hash$"

# API source change does not rebuild the detector.
printf 'print("changed")\n' > "$TMP/tree/api/main.py"
changed=$(plan 1 1)
printf '%s\n' "$changed" | grep -q '^build api '
printf '%s\n' "$changed" | grep -q "^skip detector $detector_hash$"
new_api=$(printf '%s\n' "$changed" | awk '$2=="api" { print $3 }')
test "$new_api" != "$api_hash"

# Detector dependency change does not rebuild the API.
printf 'api %s\ndetector %s\n' "$new_api" "$detector_hash" > "$TMP/stamps"
printf 'openvino\n' > "$TMP/tree/detector/requirements.txt"
deps=$(plan 1 1)
printf '%s\n' "$deps" | grep -q "^skip api $new_api$"
printf '%s\n' "$deps" | grep -q '^build detector '
new_detector=$(printf '%s\n' "$deps" | awk '$2=="detector" { print $3 }')
test "$new_detector" != "$detector_hash"

# Force rebuilds both even when the stamp matches.
printf 'api %s\ndetector %s\n' "$new_api" "$new_detector" > "$TMP/stamps"
forced=$(bash "$PLAN" --root "$TMP/tree" --stamp "$TMP/stamps" --api-present 1 --detector-present 1 --force)
printf '%s\n' "$forced" | grep -q '^build api '
printf '%s\n' "$forced" | grep -q '^build detector '

# The installer and Compose agree on the local image tags, and the installer
# still fast-forwards instead of resetting.
compose=$(cat "$ROOT/docker-compose.yml")
installer=$(cat "$ROOT/install.sh")
grep -q 'mview-sentinel-api:local' <<< "$compose"
grep -q 'mview-sentinel-detector:local' <<< "$compose"
grep -q 'pull_policy: never' <<< "$compose"
grep -q 'mview-sentinel-api:local' <<< "$installer"
grep -q 'mview-sentinel-detector:local' <<< "$installer"
grep -q 'image-build-plan.sh' <<< "$installer"
grep -q 'pg_isready' <<< "$installer"
grep -q 'merge --ff-only' <<< "$installer"
if grep -q 'reset --hard' <<< "$installer"; then
    echo "installer must not git reset --hard" >&2
    exit 1
fi
if grep -q 'entrypoint: \["/entrypoint.sh"\]' <<< "$compose"; then
    echo "compose still execs the missing detector entrypoint" >&2
    exit 1
fi

echo "image build plan ok"
