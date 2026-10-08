#!/usr/bin/env bash
# Disable inherited tracing before sourcing or expanding any secret.
{ set +x; } 2>/dev/null
set -euo pipefail

ROOT="${WAG_ROOT:-/data/web-access-gateway}"
mode="${1:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Bound the entire command, including service-manager and diagnostic failures.
if [[ "${WAG_HEALTHCHECK_BOUNDED:-}" != 1 ]]; then
  seconds="${WAG_HEALTHCHECK_TIMEOUT_SECONDS:-45}"
  if [[ ! "$seconds" =~ ^0*([1-9][0-9]?)$ ]] || ((10#${BASH_REMATCH[1]} > 60)); then
    printf '{"layer":"healthcheck","ok":false,"error":{"kind":"invalid_deadline"}}\n' >&2
    exit 1
  fi
  seconds="$((10#${BASH_REMATCH[1]}))"
  if timeout --signal=TERM --kill-after=2 "${seconds}s" env WAG_HEALTHCHECK_BOUNDED=1 WAG_HEALTHCHECK_TIMEOUT_SECONDS="$seconds" bash "$0" "$@"; then exit 0; else status=$?; fi
  if [[ "$status" == 124 || "$status" == 137 ]]; then
    printf '{"layer":"healthcheck","ok":false,"exit_code":%s,"error":{"kind":"healthcheck_timeout","message":"Overall healthcheck deadline exceeded"}}\n' "$status" >&2
  fi
  exit "$status"
fi

# Snapshot the actual outer budget before the env file can override it.
readonly healthcheck_seconds="${WAG_HEALTHCHECK_TIMEOUT_SECONDS:-45}"
SECONDS=0

# Export only into subprocesses so their diagnostics can redact secret values.
set -a
# shellcheck disable=SC1091
source "$ROOT/secrets/gateway.env"
set +a
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
trap 'exit 124' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
umask 077

diagnose() {
  python3 "$SCRIPT_DIR/healthcheck-diagnostics.py" "$1" "$2" "$3" "$work/body" "$work/error" "$work/status"
}
# Keep inner commands in the outer timeout's process group for prompt teardown.
check_command() {
  local layer="$1" status=0; shift
  : > "$work/status"
  timeout --foreground --signal=TERM --kill-after=1 8s "$@" > "$work/body" 2> "$work/error" || status=$?
  diagnose "$layer" "$status" command
}
check_http() {
  local layer="$1" validation="$2" status=0 request_seconds=8 remaining; shift 2
  # Reserve 1 s for the wrapper, 1 s for forced teardown, and 1 s for diagnostics.
  remaining=$((healthcheck_seconds - SECONDS - 3))
  if [[ "$validation" == ready || "$validation" == ready-core ]]; then
    # Match the gateway's numeric config (including decimal/exponent/base forms)
    # using the existing Python runtime, without requiring node on system PATH.
    if ! request_seconds="$(python3 - <<'PY'
import os
import re
import sys

value = os.environ.get("GATEWAY_PROBE_TIMEOUT_MS", "10000").strip()
try:
    if re.fullmatch(r"0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+", value):
        milliseconds = float(int(value, 0))
    elif re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value):
        milliseconds = float(value)
    else:
        raise ValueError()
    if not 0 < milliseconds <= 9007199254740991 or not milliseconds.is_integer():
        raise ValueError()
    # Entire server probe budget plus 2 s for transport/response.
    print((int(milliseconds) + 999) // 1000 + 2)
except (ValueError, OverflowError):
    sys.exit(1)
PY
)"; then
      printf '{"layer":"%s","ok":false,"error":{"kind":"invalid_deadline","message":"GATEWAY_PROBE_TIMEOUT_MS must be a positive safe integer"}}\n' "$layer" >&2
      return 1
    fi
    if ((request_seconds > remaining)); then
      printf '{"layer":"%s","ok":false,"error":{"kind":"invalid_deadline","message":"Readiness request plus teardown margin exceeds remaining WAG_HEALTHCHECK_TIMEOUT_SECONDS budget"}}\n' "$layer" >&2
      return 1
    fi
  elif ((request_seconds > remaining)); then
    request_seconds=$remaining
  fi
  if ((request_seconds < 1)); then
    printf '{"layer":"%s","ok":false,"error":{"kind":"healthcheck_timeout","message":"No HTTP request budget remains"}}\n' "$layer" >&2
    return 1
  fi
  : > "$work/body"
  timeout --foreground --signal=TERM --kill-after=1 "$((request_seconds + 1))s" curl --silent --show-error --max-time "$request_seconds" --max-filesize 65536 --output "$work/body" --write-out '%{http_code}' "$@" > "$work/status" 2> "$work/error" || status=$?
  diagnose "$layer" "$status" "$validation"
}

# Probe the local listener, not the logical/public hostname. Keep the Host
# header independent so the same production host allowlist is still exercised.
probe_host="${GATEWAY_HEALTHCHECK_HOST:-${GATEWAY_BIND_HOST:-127.0.0.1}}"
probe_host="${probe_host#[}"; probe_host="${probe_host%]}"
case "$probe_host" in 0.0.0.0) probe_host=127.0.0.1;; ::) probe_host=::1;; esac
[[ "$probe_host" != *:* ]] || probe_host="[$probe_host]"
logical_host="${GATEWAY_HOST:-yosef-server}"
if [[ "$logical_host" == *:* && "$logical_host" != \[*\] ]]; then logical_host="[$logical_host]"; fi
gateway_url="http://$probe_host:$GATEWAY_PORT"
gateway_host_header="Host: $logical_host:$GATEWAY_PORT"

check_command process systemctl is-active --quiet web-access-egress-proxy.service web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service
check_http gateway http --noproxy '*' -H "$gateway_host_header" -H "Authorization: Bearer $GATEWAY_TOKEN" "$gateway_url/healthz"
check_http crawl4ai http http://127.0.0.1:11235/healthz
check_http playwright playwright -H 'Host: localhost:8931' http://127.0.0.1:8931/mcp
if [[ "$mode" == --core-only ]]; then
  # Public search/egress degradation must not trigger deployment rollback.
  check_http gateway-ready ready-core --noproxy '*' -H "$gateway_host_header" -H "Authorization: Bearer $GATEWAY_TOKEN" "$gateway_url/readyz"
  exit 0
fi

degraded=0
if check_http gateway-ready ready --noproxy '*' -H "$gateway_host_header" -H "Authorization: Bearer $GATEWAY_TOKEN" "$gateway_url/readyz"; then :; else
  status=$?
  [[ "$status" == 2 ]] || exit 1
  degraded=1
fi
check_http egress-connect http --proxy http://127.0.0.1:7895 https://example.com/ || degraded=1
check_http public-search search "http://yosef-server:8801/search?q=healthcheck&format=json" || degraded=1
check_command proxy-restarts systemctl show web-access-egress-proxy.service --property=NRestarts --value || degraded=1
exit "$degraded"
