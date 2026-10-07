#!/usr/bin/env bash
set -euo pipefail

ROOT="${WAG_ROOT:-/data/web-access-gateway}"
UNIT_DIR="${WAG_SYSTEMD_DIR:-/etc/systemd/system}"
units=(web-access-artifact-cleanup.service web-access-artifact-cleanup.timer)
for unit in "${units[@]}"; do
  [[ -f "$ROOT/systemd/$unit" ]] || { printf 'Missing artifact cleanup unit: %s\n' "$unit" >&2; exit 2; }
done
install -d "$UNIT_DIR"
for unit in "${units[@]}"; do
  ln -sfn "$ROOT/systemd/$unit" "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl enable --now web-access-artifact-cleanup.timer
