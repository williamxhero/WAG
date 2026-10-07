#!/usr/bin/env bash
# WAG-owned merge-by-engine overlay. Local only; no SSH or remote deployment.
# Existing standalone usage: sudo bash searxng-apply-overlay.sh [OVERLAY]
# Offline usage: ... OVERLAY --settings TEMP/settings.yml --backup-root TEMP/backups
# Every apply retains an exclusive overlay-<stamp>/settings.yml snapshot. For an
# explicit restore use: python3 searxng-overlay.py restore BACKUP
# Coordinated runtime releases use deploy.sh prepare ... --searxng-settings FILE
# instead; the same helper takes snapshots before any mutation on either side.
{ set +x; } 2>/dev/null
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
overlay="$script_dir/../config/searxng/settings-overlay.yml"
settings=/data/searxng/config/settings.yml
backup_root=/data/searxng/backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if (( $# )) && [[ "$1" != --* ]]; then overlay="$1"; shift; fi
while (( $# )); do
  case "$1" in
    --settings) settings="$2"; shift 2;;
    --backup-root) backup_root="$2"; shift 2;;
    --stamp) stamp="$2"; shift 2;;
    *) printf 'Unknown overlay option\n' >&2; exit 1;;
  esac
done
if [[ ! "$stamp" =~ ^[A-Za-z0-9_-]+$ ]]; then printf 'Invalid backup stamp\n' >&2; exit 1; fi
install -d -m 0750 "$backup_root"
backup="$backup_root/overlay-$stamp"
prepared=0
on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  if (( status != 0 && prepared == 1 )); then
    if python3 "$script_dir/searxng-overlay.py" restore "$backup"; then
      printf 'Overlay apply failed; snapshot restored\n' >&2
    else
      printf 'Overlay restoration failed; retained retryable journal: %s\n' "$backup" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 1' INT TERM HUP
# prepare creates the backup exclusively. A collision must not trigger rollback
# against someone else's backup or overwrite its settings snapshot.
python3 "$script_dir/searxng-overlay.py" prepare "$settings" "$overlay" --backup "$backup"
prepared=1
python3 "$script_dir/searxng-overlay.py" apply "$backup"
printf 'SearXNG overlay applied and verified; backup: %s\n' "$backup"
