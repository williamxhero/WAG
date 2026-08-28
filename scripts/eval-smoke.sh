#!/usr/bin/env bash
set -euo pipefail
ROOT=/data/web-access-gateway
set -a
source "$ROOT/secrets/gateway.env"
set +a
"$ROOT/runtime/node/bin/node" "$ROOT/runtime/gateway/eval-runner.mjs" smoke
