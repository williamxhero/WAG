#!/usr/bin/env bash
set -euo pipefail

# Run on yosef-server from a staged release directory.  A failed validation
# restores the previous runtime snapshot and restarts only WAG-owned services.
ROOT=/data/web-access-gateway
SOURCE="${1:?usage: deploy.sh /path/to/staged-release}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$ROOT/releases/$stamp"
units=(web-access-egress-proxy web-access-crawl4ai web-access-playwright web-access-gateway)
install -d -o yosef -g yosef -m 0750 "$ROOT/releases" "$backup"
for path in runtime/gateway runtime/crawl4ai-service runtime/proxy systemd scripts config eval; do
  [[ -e "$ROOT/$path" ]] && { install -d "$backup/$(dirname "$path")"; cp -a "$ROOT/$path" "$backup/$path"; }
done
rollback() {
  echo "Deployment failed; restoring $backup" >&2
  for path in runtime/gateway runtime/crawl4ai-service runtime/proxy systemd scripts config eval; do
  [[ -e "$backup/$path" ]] && { rm -rf "$ROOT/$path"; cp -a "$backup/$path" "$ROOT/$path"; }
  done
  systemctl daemon-reload
  systemctl restart "${units[@]}" || true
}
trap rollback ERR
for path in gateway crawl4ai proxy systemd scripts config eval; do
  [[ -e "$SOURCE/$path" ]] || continue
  destination="$ROOT/${path/gateway/runtime/gateway}"
  [[ "$path" == crawl4ai ]] && destination="$ROOT/runtime/crawl4ai-service"
  [[ "$path" == proxy ]] && destination="$ROOT/runtime/proxy"
  install -d "$destination"
  cp -a "$SOURCE/$path/." "$destination/"
done
chown -R yosef:yosef "$ROOT/runtime" "$ROOT/config" "$ROOT/scripts" "$ROOT/systemd"
chmod 0750 "$ROOT/scripts"/*.sh
ln -sfn "$ROOT/systemd/web-access-egress-proxy.service" /etc/systemd/system/web-access-egress-proxy.service
for unit in web-access-crawl4ai web-access-playwright web-access-gateway web-access-healthcheck; do ln -sfn "$ROOT/systemd/$unit.service" "/etc/systemd/system/$unit.service"; done
ln -sfn "$ROOT/systemd/web-access-healthcheck.timer" /etc/systemd/system/web-access-healthcheck.timer
systemctl daemon-reload
systemctl enable web-access-egress-proxy.service web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service web-access-healthcheck.timer
systemctl restart "${units[@]}"
ready=false
for attempt in $(seq 1 12); do
  if "$ROOT/scripts/healthcheck.sh" --core-only; then ready=true; break; fi
  sleep 5
done
if [[ "$ready" != true ]]; then echo "Core readiness did not pass within 60 seconds" >&2; exit 1; fi
"$ROOT/scripts/healthcheck.sh" || echo "Deployment succeeded with public-connectivity degradation" >&2
trap - ERR
echo "Deployment complete; rollback snapshot: $backup"
