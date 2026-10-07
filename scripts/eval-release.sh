#!/usr/bin/env bash
# Never inherit tracing around either fixture or live credentials.
{ set +x; } 2>/dev/null
set -euo pipefail
if [[ "${1:-}" == --offline ]]; then
  # Deliberately do not source secrets, inspect host listeners or run the live
  # healthcheck (which includes public sites). The evaluator exercises readiness
  # against the controlled gateway and labels all reports as offline-only.
  [[ "$#" == 2 && "$2" == /* && -d "$2" && "$2" != / && "$2" != /data/web-access-gateway ]] || {
    printf 'Usage: eval-release.sh --offline ABSOLUTE_DISPOSABLE_ROOT\n' >&2; exit 2;
  }
  [[ "$(realpath -- "$2")" == "$2" ]] || { printf 'Offline root must be canonical\n' >&2; exit 2; }
  : "${WAG_EVAL_SAMPLES:?Explicit offline samples are required}"
  : "${GATEWAY_EVAL_URL:?Explicit loopback fixture gateway is required}"
  : "${GATEWAY_TOKEN:?Synthetic fixture authentication is required}"
  export WAG_ROOT="$2"
  exec "$WAG_ROOT/runtime/node/bin/node" "$WAG_ROOT/runtime/gateway/eval-runner.mjs" release --offline
fi
[[ "$#" == 0 ]] || { printf 'Usage: eval-release.sh [--offline ABSOLUTE_DISPOSABLE_ROOT]\n' >&2; exit 2; }
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
