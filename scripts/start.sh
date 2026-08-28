#!/usr/bin/env bash
set -euo pipefail
sudo systemctl start web-access-crawl4ai.service web-access-playwright.service web-access-gateway.service web-access-healthcheck.timer
