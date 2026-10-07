#!/usr/bin/env bash
set -euo pipefail

ROOT="${WAG_ROOT:-/data/web-access-gateway}"
NODE_BIN="${NODE_BIN:-$ROOT/runtime/node/bin/node}"
# The shared lifecycle module owns the seven-day cutoff and safe traversal.
exec "$NODE_BIN" "$ROOT/runtime/gateway/cleanup-artifacts.mjs"
