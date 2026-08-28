#!/usr/bin/env bash
set -euo pipefail

ROOT=/data/web-access-gateway
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${SUDO_USER:-yosef}"
APP_GROUP="$(id -gn "$APP_USER")"
NODE_VERSION=v22.23.2
NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
NODE_ARCH=linux-x64
CRAWL4AI_VERSION=0.9.2
FASTAPI_VERSION=0.141.1
UVICORN_VERSION=0.52.4
PROXY_URL=http://127.0.0.1:7890
INTERNAL_NO_PROXY=localhost,127.0.0.1

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo --preserve-env=SUDO_USER bash "$0" "$@"
fi
gateway_source="$SOURCE_ROOT/gateway"
crawl4ai_source="$SOURCE_ROOT/crawl4ai"
if [[ ! -d "$gateway_source" ]]; then
  gateway_source="$ROOT/runtime/gateway"
fi
if [[ ! -f "$crawl4ai_source/app.py" ]]; then
  crawl4ai_source="$ROOT/runtime/crawl4ai-service"
fi
if [[ ! -f "$gateway_source/server.mjs" || ! -f "$crawl4ai_source/app.py" ]]; then
  echo "Gateway and Crawl4AI sources are unavailable." >&2
  exit 2
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3-venv python3-pip

install -d -o "$APP_USER" -g "$APP_GROUP" -m 0750 \
  "$ROOT" "$ROOT/config" "$ROOT/secrets" "$ROOT/scripts" "$ROOT/runtime" \
  "$ROOT/runtime/gateway" "$ROOT/runtime/crawl4ai-service" "$ROOT/runtime/playwright-mcp" "$ROOT/runtime/proxy" \
  "$ROOT/data/crawl4ai" "$ROOT/logs" "$ROOT/artifacts/crawl4ai" "$ROOT/artifacts/playwright" "$ROOT/systemd" "$ROOT/compose"

if [[ "$gateway_source" != "$ROOT/runtime/gateway" ]]; then
  cp -a "$gateway_source/." "$ROOT/runtime/gateway/"
fi
if [[ "$crawl4ai_source" != "$ROOT/runtime/crawl4ai-service" ]]; then
  cp -a "$crawl4ai_source/." "$ROOT/runtime/crawl4ai-service/"
fi
if [[ "$SOURCE_ROOT/systemd" != "$ROOT/systemd" ]]; then
  cp -a "$SOURCE_ROOT/systemd/." "$ROOT/systemd/"
fi
if [[ "$SOURCE_ROOT/scripts" != "$ROOT/scripts" ]]; then
  cp -a "$SOURCE_ROOT/scripts/." "$ROOT/scripts/"
fi
if [[ "$SOURCE_ROOT/config" != "$ROOT/config" ]]; then
  cp -a "$SOURCE_ROOT/config/." "$ROOT/config/"
fi
if [[ "$SOURCE_ROOT/runtime/playwright-mcp" != "$ROOT/runtime/playwright-mcp" ]]; then
  cp -a "$SOURCE_ROOT/runtime/playwright-mcp/." "$ROOT/runtime/playwright-mcp/"
fi
if [[ "$SOURCE_ROOT/proxy" != "$ROOT/runtime/proxy" ]]; then cp -a "$SOURCE_ROOT/proxy/." "$ROOT/runtime/proxy/"; fi
chmod 0750 "$ROOT/scripts/"*.sh
chown -R "$APP_USER:$APP_GROUP" "$ROOT"

umask 077
if [[ ! -s "$ROOT/secrets/gateway.env" ]]; then
  gateway_token="$(openssl rand -hex 32)"
  crawl_token="$(openssl rand -hex 32)"
  sed -e "s/GATEWAY_TOKEN=__GENERATED__/GATEWAY_TOKEN=$gateway_token/" -e "s/CRAWL4AI_TOKEN=__GENERATED__/CRAWL4AI_TOKEN=$crawl_token/" "$ROOT/config/gateway.env.template" > "$ROOT/secrets/gateway.env"
else
  crawl_token="$(sed -n 's/^CRAWL4AI_TOKEN=//p' "$ROOT/secrets/gateway.env" | head -n 1)"
  if [[ -z "$crawl_token" ]]; then
    echo "Existing gateway secret has no Crawl4AI token." >&2
    exit 2
  fi
fi
if [[ ! -s "$ROOT/secrets/crawl4ai.env" ]]; then
  sed "s/__GENERATED__/$crawl_token/g" "$ROOT/config/crawl4ai.env.template" > "$ROOT/secrets/crawl4ai.env"
fi
chmod 0600 "$ROOT/secrets/gateway.env" "$ROOT/secrets/crawl4ai.env"
chown "$APP_USER:$APP_GROUP" "$ROOT/secrets/gateway.env" "$ROOT/secrets/crawl4ai.env"

if [[ ! -x "$ROOT/runtime/node/bin/node" ]] || [[ "$("$ROOT/runtime/node/bin/node" --version)" != "$NODE_VERSION" ]]; then
  node_tmp="$(mktemp -d)"
  node_tar="$node_tmp/node.tar.xz"
  curl --proxy "$PROXY_URL" --fail --location --retry 3 --output "$node_tar" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$NODE_ARCH.tar.xz"
  echo "$NODE_SHA256  $node_tar" | sha256sum -c -
  rm -rf "$ROOT/runtime/node"
  install -d -o "$APP_USER" -g "$APP_GROUP" "$ROOT/runtime/node"
  tar -xJf "$node_tar" -C "$ROOT/runtime/node" --strip-components=1
  chown -R "$APP_USER:$APP_GROUP" "$ROOT/runtime/node"
  rm -rf "$node_tmp"
fi

runuser -u "$APP_USER" -- env PATH="$ROOT/runtime/node/bin:$PATH" "$ROOT/runtime/node/bin/npm" ci --omit=dev --ignore-scripts --prefix "$ROOT/runtime/gateway"
runuser -u "$APP_USER" -- env PATH="$ROOT/runtime/node/bin:$PATH" "$ROOT/runtime/node/bin/npm" ci --omit=dev --prefix "$ROOT/runtime/playwright-mcp"
playwright_executable="$ROOT/runtime/playwright-browsers/chromium-1237/chrome-linux64/chrome"
if [[ ! -x "$playwright_executable" ]]; then
  runuser -u "$APP_USER" -- env PATH="$ROOT/runtime/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/playwright-browsers" "$ROOT/runtime/playwright-mcp/node_modules/.bin/playwright-mcp" install-browser chromium
fi

runuser -u "$APP_USER" -- python3 -m venv "$ROOT/runtime/crawl4ai-venv"
runuser -u "$APP_USER" -- env HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" NO_PROXY="$INTERNAL_NO_PROXY" "$ROOT/runtime/crawl4ai-venv/bin/pip" install --upgrade pip wheel
runuser -u "$APP_USER" -- env HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" NO_PROXY="$INTERNAL_NO_PROXY" "$ROOT/runtime/crawl4ai-venv/bin/pip" install --upgrade "crawl4ai==$CRAWL4AI_VERSION" "fastapi==$FASTAPI_VERSION" "uvicorn==$UVICORN_VERSION"
runuser -u "$APP_USER" -- env HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" NO_PROXY="$INTERNAL_NO_PROXY" PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/crawl4ai-browsers" "$ROOT/runtime/crawl4ai-venv/bin/crawl4ai-setup"
runuser -u "$APP_USER" -- env HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" NO_PROXY="$INTERNAL_NO_PROXY" PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/crawl4ai-browsers" "$ROOT/runtime/crawl4ai-venv/bin/crawl4ai-doctor" > "$ROOT/logs/crawl4ai-doctor.log" 2>&1
runuser -u "$APP_USER" -- env HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" NO_PROXY="$INTERNAL_NO_PROXY" "$ROOT/runtime/crawl4ai-venv/bin/pip" freeze > "$ROOT/config/crawl4ai-requirements.lock"
chown "$APP_USER:$APP_GROUP" "$ROOT/config/crawl4ai-requirements.lock" "$ROOT/logs/crawl4ai-doctor.log"

for unit in web-access-egress-proxy.service web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service web-access-healthcheck.service web-access-healthcheck.timer; do
  ln -sfn "$ROOT/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable web-access-egress-proxy.service web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service web-access-healthcheck.timer
systemctl restart web-access-egress-proxy.service
systemctl restart web-access-crawl4ai.service
systemctl restart web-access-playwright.service
systemctl restart web-access-gateway.service
systemctl start web-access-healthcheck.timer

echo "Installed native Crawl4AI, native Playwright MCP, and the authenticated gateway."
echo "Read the token locally with: ssh yosef-server 'sudo cat $ROOT/secrets/gateway.env'"
