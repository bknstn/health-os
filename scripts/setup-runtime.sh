#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

ENV_FILE=
SKIP_AUTH_URL=false

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE=$2
      shift 2
      ;;
    --skip-auth-url)
      SKIP_AUTH_URL=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$ENV_FILE" != "" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

HEALTH_OS_ROOT=${HEALTH_OS_ROOT:-$ROOT_DIR}
HEALTH_OS_WORKSPACE=${HEALTH_OS_WORKSPACE:-}
export HEALTH_OS_ROOT
export HEALTH_OS_WORKSPACE

CHECK_ARGS=
if [ "$SKIP_AUTH_URL" = true ]; then
  CHECK_ARGS="$CHECK_ARGS --skip-oura"
fi

# shellcheck disable=SC2086
"$HEALTH_OS_ROOT/scripts/check-runtime-env.sh" $CHECK_ARGS

if [ "$HEALTH_OS_WORKSPACE" = "" ]; then
  echo "HEALTH_OS_WORKSPACE is required to initialize the health workspace." >&2
  exit 1
fi

mkdir -p "$HEALTH_OS_WORKSPACE"

"$HEALTH_OS_ROOT/scripts/init-workspace.sh" --workspace "$HEALTH_OS_WORKSPACE"

if [ "$SKIP_AUTH_URL" = false ]; then
  AUTH_URL=$("$HEALTH_OS_ROOT/scripts/oura-build-auth-url.sh")
  echo "oura_auth_url=$AUTH_URL"
fi

echo "setup_complete=true"
