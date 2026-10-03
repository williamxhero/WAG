#!/usr/bin/env bash
set -euo pipefail

# Apply the WAG SearXNG outgoing-proxy overlay on yosef-server.
#
# Usage:
#   1. Copy this script and config/searxng/settings-overlay.yml to yosef-server
#      (for example with scp), then run on yosef-server:
#        sudo bash /path/to/searxng-apply-overlay.sh \
#          /path/to/settings-overlay.yml
#   2. The script must run as root because /data/searxng/config/settings.yml is
#      normally root-owned. It merges the overlay, restarts SearXNG, and checks
#      :8801 plus the JSON search API.
#
# Verification performed by this script:
#   ss confirms a listener on :8801; curl requests
#   http://yosef-server:8801/search?q=test&format=json; and Python checks that
#   the response is JSON with non-empty results and fewer than three timeout
#   entries in unresponsive_engines.
#
# Rollback:
#   Every apply creates /data/searxng/backups/overlay-<stamp>/settings.yml.
#   On a failed apply the backup is restored automatically and SearXNG is
#   restarted. To roll back a successful apply manually:
#     sudo cp -a /data/searxng/backups/overlay-<stamp>/settings.yml \
#       /data/searxng/config/settings.yml
#     sudo systemctl restart searxng.service
#
# This script only produces a local configuration change; it does not SSH to
# yosef-server or deploy anything remotely.

config_dir=/data/searxng/config
settings="$config_dir/settings.yml"
backup_root=/data/searxng/backups
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
overlay="${1:-$script_dir/../config/searxng/settings-overlay.yml}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$backup_root/overlay-$stamp"
tmp_settings=""
response_file=""
backup_created=0

cleanup() {
  if [[ -n "$tmp_settings" ]]; then rm -f -- "$tmp_settings" || true; fi
  if [[ -n "$response_file" ]]; then rm -f -- "$response_file" || true; fi
}

on_exit() {
  local status=$?
  trap - EXIT
  cleanup

  if (( status != 0 )) && (( backup_created == 1 )); then
    printf 'Apply failed; restoring %s\n' "$backup/settings.yml" >&2
    if cp -a -- "$backup/settings.yml" "$settings" \
      && systemctl restart searxng.service; then
      printf 'Automatic rollback completed; backup retained at %s\n' "$backup" >&2
    else
      printf 'Automatic rollback failed; restore %s and restart searxng.service manually\n' "$backup" >&2
      status=1
    fi
  fi

  if (( status != 0 )); then
    printf 'SearXNG overlay was not applied successfully; backup: %s\n' "$backup" >&2
  fi
  exit "$status"
}
trap on_exit EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this script as root (for example: sudo bash %s)\n' "$0" >&2
  exit 1
fi
if [[ ! -r "$overlay" ]]; then
  printf 'Overlay is not readable: %s\n' "$overlay" >&2
  exit 1
fi
if [[ ! -f "$settings" ]]; then
  printf 'SearXNG settings file is missing: %s\n' "$settings" >&2
  exit 1
fi
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
  printf 'PyYAML is required; install the python3 YAML package before retrying (for example, python3 -m pip install PyYAML).\n' >&2
  exit 1
fi

install -d -m 0750 "$backup_root"
install -d -m 0750 "$backup"
cp -a -- "$settings" "$backup/settings.yml"
backup_created=1

tmp_settings="$(mktemp "$config_dir/.settings.yml.XXXXXX")"
python3 - "$settings" "$overlay" "$tmp_settings" <<'PY'
import copy
import os
import stat
import sys

import yaml

settings_path, overlay_path, output_path = sys.argv[1:]
with open(settings_path, encoding="utf-8") as handle:
    base = yaml.safe_load(handle) or {}
with open(overlay_path, encoding="utf-8") as handle:
    overlay = yaml.safe_load(handle) or {}

if not isinstance(base, dict) or not isinstance(overlay, dict):
    raise SystemExit("settings.yml and the overlay must contain YAML mappings at the root")


def is_named_engine_list(value):
    return isinstance(value, list) and all(
        isinstance(item, dict) and isinstance(item.get("name"), str)
        for item in value
    )


def merge(base_value, overlay_value, key=None):
    if isinstance(base_value, dict) and isinstance(overlay_value, dict):
        merged = copy.deepcopy(base_value)
        for child_key, child_value in overlay_value.items():
            merged[child_key] = merge(
                merged[child_key], child_value, child_key
            ) if child_key in merged else copy.deepcopy(child_value)
        return merged

    if key == "engines" and is_named_engine_list(base_value) and is_named_engine_list(overlay_value):
        merged = copy.deepcopy(base_value)
        positions = {item["name"]: index for index, item in enumerate(merged)}
        for item in overlay_value:
            name = item["name"]
            if name in positions:
                index = positions[name]
                merged[index] = merge(merged[index], item)
            else:
                positions[name] = len(merged)
                merged.append(copy.deepcopy(item))
        return merged

    return copy.deepcopy(overlay_value)


merged = merge(base, overlay)
mode = stat.S_IMODE(os.stat(settings_path).st_mode)
with open(output_path, "w", encoding="utf-8") as handle:
    yaml.safe_dump(
        merged,
        handle,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    )
os.chmod(output_path, mode)
PY
chmod --reference="$settings" "$tmp_settings"
mv -- "$tmp_settings" "$settings"
tmp_settings=""

systemctl restart searxng.service

response_file="$(mktemp)"
verify_search() {
  for _ in $(seq 1 30); do
    if ss -ltn | grep -Eq '(^|[[:space:]])[^[:space:]]*:8801([[:space:]]|$)' \
      && curl --silent --show-error --fail --max-time 10 \
        --get 'http://yosef-server:8801/search' \
        --data-urlencode 'q=test' --data 'format=json' \
        --output "$response_file" \
      && python3 - "$response_file" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    body = json.load(handle)
if not isinstance(body, dict):
    raise SystemExit("SearXNG response was not a JSON object")
results = body.get("results")
if not isinstance(results, list) or not results:
    raise SystemExit("SearXNG JSON response contained no results")

unresponsive = body.get("unresponsive_engines") or []
if not isinstance(unresponsive, list):
    raise SystemExit("SearXNG unresponsive_engines was not a list")
timeouts = []
for entry in unresponsive:
    label = " ".join(str(value) for value in entry) if isinstance(entry, list) else str(entry)
    if re.search(r"timeout|timed\s+out|time\s+out", label, re.IGNORECASE):
        timeouts.append(label)
if len(timeouts) >= 3:
    raise SystemExit(
        "SearXNG still reports a broad timeout cluster: " + ", ".join(timeouts)
    )
if unresponsive:
    print("unresponsive_engines:", json.dumps(unresponsive, ensure_ascii=False))
PY
    then
      return 0
    fi
    sleep 1
  done
  printf 'SearXNG did not expose a healthy non-empty format=json response on :8801\n' >&2
  return 1
}

verify_search
printf 'SearXNG overlay applied and verified; backup: %s\n' "$backup"
