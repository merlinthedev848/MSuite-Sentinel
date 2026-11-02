#!/bin/bash

# mView Sentinel installer.
# Run it from a checkout you trust. Do not pipe this script from the network.

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

echo -e "\n\033[1;33m[5/6] Building images...\033[0m"
docker compose "${COMPOSE_ARGS[@]}" build

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
echo "  Health:     http://127.0.0.1:8000/system/health"
echo "  Postgres, MQTT, and go2rtc listen on 127.0.0.1 only."
echo "  The first admin password is a random value, not admin."
echo "  Read it once with:"
echo "    docker compose ${COMPOSE_ARGS[*]} exec -T api cat /run/sentinel/secrets/admin_password"
echo "  Logs: cd $INSTALL_DIR && docker compose ${COMPOSE_ARGS[*]} logs -f api"
