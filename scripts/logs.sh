#!/usr/bin/env bash
set -euo pipefail
service="${1:-gateway}"
case "$service" in
  gateway) unit=web-access-gateway.service ;;
  crawl4ai) unit=web-access-crawl4ai.service ;;
  playwright) unit=web-access-playwright.service ;;
  *) echo "Usage: $0 {gateway|crawl4ai|playwright}" >&2; exit 2 ;;
esac
exec journalctl -u "$unit" -n 200 --no-pager
