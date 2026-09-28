#!/usr/bin/env bash
set -euo pipefail

ROOT=/data/web-access-gateway
mode="${1:-}"
# shellcheck disable=SC1091
source "$ROOT/secrets/gateway.env"
check() { local layer="$1"; shift; if "$@" >/dev/null 2>&1; then printf '{"layer":"%s","ok":true}\n' "$layer"; else printf '{"layer":"%s","ok":false}\n' "$layer" >&2; return 1; fi; }
check process systemctl is-active --quiet web-access-egress-proxy.service web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service
check gateway curl --fail --silent --show-error --max-time 10 -H "Authorization: Bearer $GATEWAY_TOKEN" "http://$GATEWAY_HOST:$GATEWAY_PORT/healthz"
check crawl4ai curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:11235/healthz"
playwright_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 -H 'Host: localhost:8931' http://127.0.0.1:8931/mcp || true)"
case "$playwright_status" in 200|400|405|406) printf '{"layer":"playwright","ok":true}\n';; *) printf '{"layer":"playwright","ok":false,"http_status":"%s"}\n' "$playwright_status" >&2; exit 1;; esac
[[ "$mode" == "--core-only" ]] && exit 0
check gateway-ready curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer $GATEWAY_TOKEN" "http://$GATEWAY_HOST:$GATEWAY_PORT/readyz"
degraded=0
check egress-connect curl --fail --silent --show-error --max-time 10 --proxy http://127.0.0.1:7895 https://example.com/ || degraded=1
check public-search curl --fail --silent --show-error --max-time 10 "http://yosef-server:8801/search?q=healthcheck&format=json" || degraded=1
restarts="$(systemctl show web-access-egress-proxy.service --property=NRestarts --value)"
printf '{"layer":"proxy-restarts","ok":true,"count":%s}\n' "${restarts:-0}"
exit "$degraded"
