#!/usr/bin/env bash
set -euo pipefail

ROOT=/data/web-access-gateway
NODE="$ROOT/runtime/node/bin/node"
NPM="$ROOT/runtime/node/bin/npm"
# The services run as this identity (see systemd/web-access-*.service User=/Group=).
APP_USER=yosef
APP_GROUP=yosef
usage() {
  echo "Usage: $0 --crawl4ai VERSION | --playwright-mcp VERSION | --gateway" >&2
  exit 2
}
# Deployment-layer guarantee that the shared browser staging tree exists with the
# application identity before any unit starts. The units also prepare it as root
# in ExecStartPre, but provisioning it here keeps a fresh/upgraded host correct
# even before the units are (re)installed. Idempotent and fail-closed: "set -e"
# aborts the upgrade if the directories cannot be provisioned, so an operator
# never proceeds to a restart that would fail on ownership.
prepare_runtime_dirs() {
  sudo install -d -o "$APP_USER" -g "$APP_GROUP" -m 0750 \
    "$ROOT/data" \
    "$ROOT/data/playwright" \
    "$ROOT/data/playwright/output" \
    "$ROOT/data/playwright/config" \
    "$ROOT/data/playwright/cache"
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
    prepare_runtime_dirs
    PATH="$ROOT/runtime/node/bin:$PATH" "$NPM" install --save-exact "@playwright/mcp@$2" --prefix "$ROOT/runtime/playwright-mcp"
    PATH="$ROOT/runtime/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/playwright-browsers" "$ROOT/runtime/playwright-mcp/node_modules/.bin/playwright-mcp" install-browser chromium
    sudo systemctl restart web-access-playwright.service
    ;;
  --gateway)
    prepare_runtime_dirs
    PATH="$ROOT/runtime/node/bin:$PATH" "$NPM" ci --omit=dev --prefix "$ROOT/runtime/gateway"
    sudo systemctl restart web-access-gateway.service
    ;;
  *) usage ;;
esac
# Fail-closed: a nonzero healthcheck aborts here (set -e), so operators never see
# a green exit over an unhealthy upgrade. This convenience path is not
# transactional; the authoritative staged release with snapshot/restore rollback
# is scripts/deploy.sh (release.py prepare/activate/commit, abort/restore). Use it
# whenever an upgrade must be reversible.
"$ROOT/scripts/healthcheck.sh"
