#!/usr/bin/env bash
set -euo pipefail

ROOT=/data/web-access-gateway
ARTIFACTS="$ROOT/artifacts"
if [[ ! -d "$ARTIFACTS" || "$ARTIFACTS" != /data/web-access-gateway/artifacts ]]; then
  echo "Artifact directory is not the expected dedicated path." >&2
  exit 2
fi
find "$ARTIFACTS" -type f \( -name '*.png' -o -name '*.pdf' -o -name '*.html' \) -mtime +7 -print -delete
find "$ARTIFACTS" -type d -empty -delete
