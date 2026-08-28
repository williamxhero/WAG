#!/usr/bin/env bash
set -euo pipefail

ROOT=/data/web-access-gateway
NODE="$ROOT/runtime/node/bin/node"
NPM="$ROOT/runtime/node/bin/npm"
usage() {
  echo "Usage: $0 --crawl4ai VERSION | --playwright-mcp VERSION | --gateway" >&2
  exit 2
}
case "${1:-}" in
  --crawl4ai)
    [[ -n "${2:-}" ]] || usage
    "$ROOT/runtime/crawl4ai-venv/bin/pip" install --upgrade "crawl4ai==$2"
    PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/crawl4ai-browsers" "$ROOT/runtime/crawl4ai-venv/bin/crawl4ai-setup"
    "$ROOT/runtime/crawl4ai-venv/bin/pip" freeze > "$ROOT/config/crawl4ai-requirements.lock"
    sudo systemctl restart web-access-crawl4ai.service
    ;;
  --playwright-mcp)
    [[ -n "${2:-}" ]] || usage
    PATH="$ROOT/runtime/node/bin:$PATH" "$NPM" install --save-exact "@playwright/mcp@$2" --prefix "$ROOT/runtime/playwright-mcp"
    PATH="$ROOT/runtime/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/playwright-browsers" "$ROOT/runtime/playwright-mcp/node_modules/.bin/playwright-mcp" install-browser chromium
    sudo systemctl restart web-access-playwright.service
    ;;
  --gateway)
    PATH="$ROOT/runtime/node/bin:$PATH" "$NPM" ci --omit=dev --prefix "$ROOT/runtime/gateway"
    sudo systemctl restart web-access-gateway.service
    ;;
  *) usage ;;
esac
"$ROOT/scripts/healthcheck.sh"
