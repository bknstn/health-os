#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
exec node "$ROOT_DIR/src/cli.js" personal-files-dir ${HEALTH_OS_WORKSPACE:+--workspace "$HEALTH_OS_WORKSPACE"} "$@"
