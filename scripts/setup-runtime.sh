#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

ENV_FILE=
SKIP_REGISTER=false
SKIP_AUTH_URL=false

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE=$2
      shift 2
      ;;
    --skip-register)
      SKIP_REGISTER=true
      shift
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
GROUP_FOLDER=${GROUP_FOLDER:-telegram_health-tracker}
HEALTH_OS_WORKSPACE=${HEALTH_OS_WORKSPACE:-}
export HEALTH_OS_ROOT
export HEALTH_OS_WORKSPACE
export GROUP_FOLDER
export GROUP_NAME=${GROUP_NAME:-Health Tracker}
export ASSISTANT_TRIGGER=${ASSISTANT_TRIGGER:-@Andy}

CHECK_ARGS=
if [ "$SKIP_REGISTER" = true ]; then
  CHECK_ARGS="$CHECK_ARGS --skip-nanoclaw"
fi
if [ "$SKIP_AUTH_URL" = true ]; then
  CHECK_ARGS="$CHECK_ARGS --skip-oura"
fi

# shellcheck disable=SC2086
"$HEALTH_OS_ROOT/scripts/check-runtime-env.sh" $CHECK_ARGS

if [ "$SKIP_REGISTER" = false ]; then
  "$HEALTH_OS_ROOT/examples/nanoclaw/register-health-tracker.sh"
fi

if [ "$HEALTH_OS_WORKSPACE" = "" ]; then
  echo "HEALTH_OS_WORKSPACE is required to initialize the group workspace." >&2
  exit 1
fi

mkdir -p "$HEALTH_OS_WORKSPACE"

if [ ! -f "$HEALTH_OS_WORKSPACE/CLAUDE.md" ]; then
  cp "$HEALTH_OS_ROOT/templates/nanoclaw/telegram_health-tracker/CLAUDE.md" "$HEALTH_OS_WORKSPACE/CLAUDE.md"
  echo "Copied CLAUDE.md template into $HEALTH_OS_WORKSPACE."
else
  echo "Kept existing $HEALTH_OS_WORKSPACE/CLAUDE.md."
fi

"$HEALTH_OS_ROOT/scripts/init-workspace.sh" --workspace "$HEALTH_OS_WORKSPACE"

if [ "$SKIP_AUTH_URL" = false ]; then
  AUTH_URL=$("$HEALTH_OS_ROOT/scripts/oura-build-auth-url.sh")
  echo "oura_auth_url=$AUTH_URL"
fi

echo "setup_complete=true"
