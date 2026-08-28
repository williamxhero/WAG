#!/usr/bin/env bash
set -euo pipefail
ROOT=/data/web-access-gateway
set -a
source "$ROOT/secrets/gateway.env"
set +a
"$(dirname "$0")/healthcheck.sh"
direct_host="$(getent ahostsv4 yosef-server | awk 'NR==1 {print $1}')"
[[ -n "$direct_host" ]]
ss -ltn '( sport = :8930 or sport = :8801 )' | grep -F "$direct_host" >/dev/null
ss -ltn '( sport = :8931 or sport = :11235 or sport = :7895 )' | grep -F '127.0.0.1' >/dev/null
"$ROOT/runtime/node/bin/node" "$ROOT/runtime/gateway/eval-runner.mjs" release
