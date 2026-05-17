#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

ENV_FILE=
SKIP_OURA=false
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE=$2
      shift 2
      ;;
    --skip-oura)
      SKIP_OURA=true
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
status=0

value_of() {
  eval "printf '%s' \"\${$1:-}\""
}

require_env() {
  name=$1
  value=$(value_of "$name")
  if [ "$value" = "" ]; then
    printf 'missing_env=%s\n' "$name"
    status=1
  else
    printf 'ok_env=%s\n' "$name"
  fi
}

check_dir() {
  label=$1
  dir_path=$2
  if [ -d "$dir_path" ]; then
    printf 'ok_dir=%s:%s\n' "$label" "$dir_path"
  else
    printf 'missing_dir=%s:%s\n' "$label" "$dir_path"
    status=1
  fi
}

check_dir_optional() {
  label=$1
  dir_path=$2
  if [ -d "$dir_path" ]; then
    printf 'ok_dir=%s:%s\n' "$label" "$dir_path"
  else
    printf 'missing_optional_dir=%s:%s\n' "$label" "$dir_path"
  fi
}

check_file_optional() {
  label=$1
  file_path=$2
  if [ -f "$file_path" ]; then
    printf 'ok_file=%s:%s\n' "$label" "$file_path"
  else
    printf 'missing_optional_file=%s:%s\n' "$label" "$file_path"
  fi
}

check_script() {
  script_path=$1
  if [ -x "$script_path" ]; then
    printf 'ok_script=%s\n' "$script_path"
  else
    printf 'missing_or_nonexec_script=%s\n' "$script_path"
    status=1
  fi
}

require_env HEALTH_OS_WORKSPACE
if [ "$SKIP_OURA" = false ]; then
  require_env OURA_CLIENT_ID
  require_env OURA_CLIENT_SECRET
  require_env OURA_REDIRECT_URI
  require_env OURA_TOKEN_FILE
fi
check_dir HEALTH_OS_ROOT "$HEALTH_OS_ROOT"

if [ "$(value_of HEALTH_OS_WORKSPACE)" != "" ]; then
  check_dir_optional HEALTH_OS_WORKSPACE "$(value_of HEALTH_OS_WORKSPACE)"
  check_file_optional TRACKER_STATE "$(value_of HEALTH_OS_WORKSPACE)/.health-os/config/exercise-settings.json"
fi

if [ "$SKIP_OURA" = false ] && [ "$(value_of OURA_TOKEN_FILE)" != "" ]; then
  check_file_optional OURA_TOKEN_FILE "$(value_of OURA_TOKEN_FILE)"
fi

check_script "$HEALTH_OS_ROOT/scripts/init-workspace.sh"
if [ "$SKIP_OURA" = false ]; then
  check_script "$HEALTH_OS_ROOT/scripts/oura-build-auth-url.sh"
  check_script "$HEALTH_OS_ROOT/scripts/oura-sync-from-token.sh"
fi

if [ $status -ne 0 ]; then
  exit 1
fi
