#!/usr/bin/env bash
set -euo pipefail

ROOT=/data/web-access-gateway
# shellcheck disable=SC1091
source "$ROOT/secrets/gateway.env"
curl --fail --silent --show-error --max-time 10 -H "Authorization: Bearer $GATEWAY_TOKEN" "http://$GATEWAY_HOST:$GATEWAY_PORT/healthz" >/dev/null
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:11235/healthz" >/dev/null
curl --fail --silent --show-error --max-time 10 --proxy http://127.0.0.1:7895 https://example.com/ >/dev/null
playwright_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 -H 'Host: localhost:8931' http://127.0.0.1:8931/mcp || true)"
case "$playwright_status" in 200|400|405|406) ;; *) echo "Playwright MCP health probe returned HTTP $playwright_status" >&2; exit 1 ;; esac
curl --fail --silent --show-error --max-time 10 "http://yosef-server:8801/search?q=healthcheck&format=json" >/dev/null
