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
  if [[ ! "$seconds" =~ ^[0-9]+$ ]] || ((seconds < 1 || seconds > 60)); then
    printf '{"layer":"healthcheck","ok":false,"error":{"kind":"invalid_deadline"}}\n' >&2
    exit 1
  fi
  if timeout --signal=TERM --kill-after=2 "${seconds}s" env WAG_HEALTHCHECK_BOUNDED=1 bash "$0" "$@"; then exit 0; else status=$?; fi
  if [[ "$status" == 124 || "$status" == 137 ]]; then
    printf '{"layer":"healthcheck","ok":false,"exit_code":%s,"error":{"kind":"healthcheck_timeout","message":"Overall healthcheck deadline exceeded"}}\n' "$status" >&2
  fi
  exit "$status"
fi

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
  local layer="$1" validation="$2" status=0; shift 2
  : > "$work/body"
  timeout --foreground --signal=TERM --kill-after=1 9s curl --silent --show-error --max-time 8 --max-filesize 65536 --output "$work/body" --write-out '%{http_code}' "$@" > "$work/status" 2> "$work/error" || status=$?
  diagnose "$layer" "$status" "$validation"
}

check_command process systemctl is-active --quiet web-access-egress-proxy.service web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service
check_http gateway http -H "Authorization: Bearer $GATEWAY_TOKEN" "http://$GATEWAY_HOST:$GATEWAY_PORT/healthz"
check_http crawl4ai http http://127.0.0.1:11235/healthz
check_http playwright playwright -H 'Host: localhost:8931' http://127.0.0.1:8931/mcp
if [[ "$mode" == --core-only ]]; then
  # Public search/egress degradation must not trigger deployment rollback.
  check_http gateway-ready ready-core -H "Authorization: Bearer $GATEWAY_TOKEN" "http://$GATEWAY_HOST:$GATEWAY_PORT/readyz"
  exit 0
fi

degraded=0
if check_http gateway-ready ready -H "Authorization: Bearer $GATEWAY_TOKEN" "http://$GATEWAY_HOST:$GATEWAY_PORT/readyz"; then :; else
  status=$?
  [[ "$status" == 2 ]] || exit 1
  degraded=1
fi
check_http egress-connect http --proxy http://127.0.0.1:7895 https://example.com/ || degraded=1
check_http public-search search "http://yosef-server:8801/search?q=healthcheck&format=json" || degraded=1
check_command proxy-restarts systemctl show web-access-egress-proxy.service --property=NRestarts --value || degraded=1
exit "$degraded"
