#!/usr/bin/env bash
# No live defaults: callers must name both installation and unit roots.
{ set +x; } 2>/dev/null
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/release.py" "$@"
