#!/bin/bash

# mView Sentinel installer.
# Run it from a checkout you trust. Do not pipe this script from the network.
# It fast-forwards origin/main. It does not read the update manifest and it
# does not reset the worktree. Image builds follow scripts/image-build-plan.sh:
# an unchanged API or detector image is left in place. SENTINEL_REBUILD=1
# builds both images.

set -euo pipefail

echo -e "\033[1;36m=============================================================\033[0m"
echo -e "\033[1;36m   mView Sentinel NVR — Installer                           \033[0m"
echo -e "\033[1;36m=============================================================\033[0m"

echo -e "\n\033[1;33m[1/6] Checking system dependencies...\033[0m"

if ! command -v git >/dev/null 2>&1; then
    echo "Git not found. Installing..."
    apt-get update -yq && apt-get install -yq git
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker not found. Installing..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh && rm get-docker.sh
    echo "Docker installed."
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose plugin not found. Installing..."
    apt-get update -yq && apt-get install -yq docker-compose-plugin
fi

echo -e "\n\033[1;33m[2/6] Updating the local checkout...\033[0m"
step_started=$(date +%s)
INSTALL_DIR="/opt/mview-sentinel"
REPO_URL="https://github.com/merlinthedev848/MSuite-Sentinel.git"

if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Existing installation found. Fast-forwarding main..."
    cd "$INSTALL_DIR"
    git fetch origin main
    git merge --ff-only origin/main
else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
echo "  checkout updated in $(( $(date +%s) - step_started ))s"

echo -e "\n\033[1;33m[3/6] Selecting the compose file...\033[0m"
COMPOSE_ARGS=(-f docker-compose.yml)
if command -v nvidia-smi >/dev/null 2>&1; then
    echo "NVIDIA GPU detected. The detector override requests CUDA."
    echo "The published detector image is still the CPU PyTorch build unless you rebuild it for CUDA."
    COMPOSE_ARGS+=(-f docker-compose.gpu.yml)
else
    echo "No NVIDIA GPU detected. Using the CPU detector."
fi

echo -e "\n\033[1;33m[4/6] Preparing storage directories...\033[0m"
mkdir -p /mnt/storage/mview/recordings
mkdir -p /opt/mview-sentinel/thumbnails
mkdir -p /opt/mview-sentinel/snapshots
mkdir -p /opt/mview-sentinel/exports
mkdir -p /opt/mview-sentinel/secrets

echo -e "\n\033[1;33m[5/6] Building images whose files changed...\033[0m"
step_started=$(date +%s)
if [ ! -d web/dist ] || [ -z "$(find web/dist -type f ! -name '.DS_Store' -print -quit)" ]; then
    echo "web/dist is missing. The API image serves that built dashboard. This installer does not run npm."
    exit 1
fi

# Local tags so an upgrade cannot pull these services from a registry.
API_IMAGE=mview-sentinel-api:local
DETECTOR_IMAGE=mview-sentinel-detector:local
STAMP_DIR=/var/lib/mview-sentinel
if ! mkdir -p "$STAMP_DIR" 2>/dev/null; then
    STAMP_DIR="$INSTALL_DIR/.sentinel"
    mkdir -p "$STAMP_DIR"
fi
STAMP_FILE="$STAMP_DIR/image-stamps"

api_present=0
detector_present=0
if docker image inspect "$API_IMAGE" >/dev/null 2>&1; then
    api_present=1
fi
if docker image inspect "$DETECTOR_IMAGE" >/dev/null 2>&1; then
    detector_present=1
fi

plan_args=(
    --root "$INSTALL_DIR"
    --stamp "$STAMP_FILE"
    --api-present "$api_present"
    --detector-present "$detector_present"
)
if [ "${SENTINEL_REBUILD:-0}" = "1" ]; then
    echo "SENTINEL_REBUILD=1 — rebuilding the API and detector images."
    plan_args+=(--force)
fi

plan_out=$(mktemp)
if ! bash "$INSTALL_DIR/scripts/image-build-plan.sh" "${plan_args[@]}" > "$plan_out"; then
    echo "Could not decide which images to build." >&2
    rm -f "$plan_out"
    exit 1
fi

build_services=()
api_hash=""
detector_hash=""
while read -r action service hash; do
    [ -n "$action" ] || continue
    case "$action" in
        skip)
            echo "  $service unchanged (${hash:0:12}); leaving the image in place"
            ;;
        build)
            echo "  $service will be built (${hash:0:12})"
            build_services+=("$service")
            ;;
        *)
            echo "Image plan returned: $action $service $hash" >&2
            rm -f "$plan_out"
            exit 1
            ;;
    esac
    case "$service" in
        api) api_hash=$hash ;;
        detector) detector_hash=$hash ;;
    esac
done < "$plan_out"
rm -f "$plan_out"

if [ -z "$api_hash" ] || [ -z "$detector_hash" ]; then
    echo "Image plan did not name both services." >&2
    exit 1
fi

if [ ${#build_services[@]} -gt 0 ]; then
    build_started=$(date +%s)
    docker compose "${COMPOSE_ARGS[@]}" build "${build_services[@]}"
    echo "  compose build finished in $(( $(date +%s) - build_started ))s"
else
    echo "  skipped image build; image inputs are unchanged"
fi

docker image inspect "$API_IMAGE" >/dev/null
docker image inspect "$DETECTOR_IMAGE" >/dev/null
stamp_tmp=$(mktemp)
printf 'api %s\ndetector %s\n' "$api_hash" "$detector_hash" > "$stamp_tmp"
mv "$stamp_tmp" "$STAMP_FILE"
echo "  image step finished in $(( $(date +%s) - step_started ))s"

echo -e "\n\033[1;33m[6/6] Starting services...\033[0m"
docker compose "${COMPOSE_ARGS[@]}" up -d secrets-init postgres mqtt go2rtc
echo "Waiting for PostgreSQL..."
ready=0
for _ in $(seq 1 30); do
    if docker compose "${COMPOSE_ARGS[@]}" exec -T postgres pg_isready -U sentinel -d sentinelnvr >/dev/null 2>&1; then
        ready=1
        break
    fi
    printf '.'
    sleep 2
done
echo ""
if [ "$ready" -ne 1 ]; then
    echo "PostgreSQL did not become ready in 60 seconds."
    exit 1
fi

docker compose "${COMPOSE_ARGS[@]}" up -d

echo -e "\n\033[1;32m=============================================================\033[0m"
echo -e "\033[1;32m  mView Sentinel is starting\033[0m"
echo -e "\033[1;32m=============================================================\033[0m"
echo "  Dashboard:  http://127.0.0.1:8000"
lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "${lan_ip:-}" ]; then
    echo "  On the LAN: http://${lan_ip}:8000/"
fi
echo "  Confirm:    curl -fsS -m 5 -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8000/"
echo "  Logs:       docker compose logs api --tail 100"
echo "              Expect: sentinel-api listening on http://0.0.0.0:8000/"
echo "  Health:     http://127.0.0.1:8000/system/health"
echo "  Postgres, MQTT, and go2rtc listen on 127.0.0.1 only."
echo "  The first admin password is a random value, not admin."
echo "  Read it once with:"
echo "    docker compose ${COMPOSE_ARGS[*]} exec -T api cat /run/sentinel/secrets/admin_password"
echo "  Logs: cd $INSTALL_DIR && docker compose ${COMPOSE_ARGS[*]} logs -f api"
