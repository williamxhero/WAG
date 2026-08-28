#!/usr/bin/env bash
set -euo pipefail
sudo systemctl stop web-access-healthcheck.timer web-access-gateway.service web-access-playwright.service web-access-crawl4ai.service
