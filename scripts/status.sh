#!/usr/bin/env bash
set -euo pipefail
systemctl --no-pager --full status web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service
