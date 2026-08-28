#!/usr/bin/env bash
set -euo pipefail

# Run on yosef-server.  This deliberately touches only SearXNG configuration.
config=/data/searxng/config
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/data/searxng/backups/bind-direct-$stamp"
install -d -m 0750 "$backup"
cp -a "$config/." "$backup/"
direct_host="$(getent ahostsv4 yosef-server | awk 'NR==1 {print $1}')"
[[ -n "$direct_host" ]]
for file in "$config/uwsgi.ini" "$config/settings.yml"; do
  [[ -f "$file" ]] || continue
  sed -Ei "s#(http-socket[[:space:]]*=[[:space:]]*).+:8801#\\1${direct_host}:8801#; s#(socket[[:space:]]*=[[:space:]]*).+:8801#\\1${direct_host}:8801#" "$file"
done
systemctl restart searxng.service
ss -ltn '( sport = :8801 )' | grep -F "${direct_host}:8801"
echo "SearXNG configuration backup: $backup"
