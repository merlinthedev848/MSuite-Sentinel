#!/bin/bash
# Decide whether the API and detector images need a rebuild.
#
# A service is skipped only when its local image exists and the recorded
# content hash still matches the files that image was built from. Anything
# else builds that service. This does not fetch manifests or change git state.

set -euo pipefail

ROOT=""
STAMP=""
API_PRESENT=0
DETECTOR_PRESENT=0
FORCE=0

usage() {
    echo "usage: image-build-plan.sh --root DIR --stamp FILE --api-present 0|1 --detector-present 0|1 [--force]" >&2
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --root)
            ROOT=$2
            shift 2
            ;;
        --stamp)
            STAMP=$2
            shift 2
            ;;
        --api-present)
            API_PRESENT=$2
            shift 2
            ;;
        --detector-present)
            DETECTOR_PRESENT=$2
            shift 2
            ;;
        --force)
            FORCE=1
            shift
            ;;
        *)
            usage
            ;;
    esac
done

if [ -z "$ROOT" ] || [ -z "$STAMP" ]; then
    usage
fi
case "$API_PRESENT" in
    0|1) ;;
    *) usage ;;
esac
case "$DETECTOR_PRESENT" in
    0|1) ;;
    *) usage ;;
esac

hash_paths() {
    local root=$1
    shift
    local manifest tmp
    manifest=$(mktemp)
    tmp=$(mktemp)
    (
        cd "$root"
        : > "$tmp"
        for path in "$@"; do
            if [ ! -e "$path" ]; then
                printf 'missing:%s\n' "$path" >> "$tmp"
            elif [ -f "$path" ]; then
                printf '%s\n' "$path" >> "$tmp"
            else
                find "$path" \
                    \( -type d \( -name __pycache__ -o -name node_modules -o -name .pytest_cache \) -prune \) -o \
                    -type f ! -name '*.pyc' ! -name '.DS_Store' -print >> "$tmp"
            fi
        done
        sort -u "$tmp" | while IFS= read -r rel || [ -n "$rel" ]; do
            [ -n "$rel" ] || continue
            case "$rel" in
                missing:*)
                    printf '%s\n' "$rel"
                    ;;
                *)
                    sha256sum -- "$rel"
                    ;;
            esac
        done
        rm -f "$tmp"
    ) > "$manifest"
    sha256sum "$manifest" | awk 'NR==1 { print $1 }'
    rm -f "$manifest"
}

stamp_hash() {
    local service=$1
    if [ ! -f "$STAMP" ]; then
        return 0
    fi
    awk -v service="$service" '$1 == service { print $2; exit }' "$STAMP"
}

decide() {
    local service=$1
    local hash=$2
    local present=$3
    local recorded=""
    recorded=$(stamp_hash "$service" || true)
    if [ "$FORCE" -eq 1 ] || [ "$present" -ne 1 ] || [ -z "$recorded" ] || [ "$recorded" != "$hash" ]; then
        printf 'build %s %s\n' "$service" "$hash"
    else
        printf 'skip %s %s\n' "$service" "$hash"
    fi
}

api_hash=$(hash_paths "$ROOT" .dockerignore api web/dist docker/entrypoint-api.sh)
detector_hash=$(hash_paths "$ROOT" detector)

decide api "$api_hash" "$API_PRESENT"
decide detector "$detector_hash" "$DETECTOR_PRESENT"
