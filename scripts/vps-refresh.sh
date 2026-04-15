#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

SYNC_OUTPUT=$("$ROOT_DIR/scripts/oura-sync-from-token.sh" "$@")
printf '%s\n' "$SYNC_OUTPUT"

"$ROOT_DIR/scripts/today.sh" >/dev/null
"$ROOT_DIR/scripts/weekly-summary.sh" >/dev/null

printf '%s\n' "artifacts_refreshed=true"
