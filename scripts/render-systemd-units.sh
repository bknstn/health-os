#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

ENV_FILE=
OUTPUT_DIR=
RUN_AS_USER=
RUN_AS_GROUP=
ON_CALENDAR='*-*-* 06:30:00'
RANDOMIZED_DELAY_SEC='10m'
CALLBACK_HOST=
CALLBACK_PORT=

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE=$2
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR=$2
      shift 2
      ;;
    --run-as-user)
      RUN_AS_USER=$2
      shift 2
      ;;
    --run-as-group)
      RUN_AS_GROUP=$2
      shift 2
      ;;
    --on-calendar)
      ON_CALENDAR=$2
      shift 2
      ;;
    --randomized-delay-sec)
      RANDOMIZED_DELAY_SEC=$2
      shift 2
      ;;
    --callback-host)
      CALLBACK_HOST=$2
      shift 2
      ;;
    --callback-port)
      CALLBACK_PORT=$2
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$ENV_FILE" = "" ]; then
  echo "--env-file is required" >&2
  exit 1
fi

if [ "$OUTPUT_DIR" = "" ]; then
  echo "--output-dir is required" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

HEALTH_OS_ROOT=${HEALTH_OS_ROOT:-$ROOT_DIR}
RUN_AS_USER=${RUN_AS_USER:-${HEALTH_OS_SYSTEM_USER:-healthos}}
RUN_AS_GROUP=${RUN_AS_GROUP:-${HEALTH_OS_SYSTEM_GROUP:-$RUN_AS_USER}}
CALLBACK_HOST=${CALLBACK_HOST:-${OURA_CALLBACK_HOST:-127.0.0.1}}
CALLBACK_PORT=${CALLBACK_PORT:-${OURA_CALLBACK_PORT:-8787}}

mkdir -p "$OUTPUT_DIR"

escape_sed() {
  printf '%s' "$1" | sed 's/[\/&|]/\\&/g'
}

render_template() {
  template_path=$1
  output_path=$2
  sed \
    -e "s|__RUN_AS_USER__|$(escape_sed "$RUN_AS_USER")|g" \
    -e "s|__RUN_AS_GROUP__|$(escape_sed "$RUN_AS_GROUP")|g" \
    -e "s|__HEALTH_OS_ROOT__|$(escape_sed "$HEALTH_OS_ROOT")|g" \
    -e "s|__ENV_FILE__|$(escape_sed "$ENV_FILE")|g" \
    -e "s|__ON_CALENDAR__|$(escape_sed "$ON_CALENDAR")|g" \
    -e "s|__RANDOMIZED_DELAY_SEC__|$(escape_sed "$RANDOMIZED_DELAY_SEC")|g" \
    -e "s|__CALLBACK_HOST__|$(escape_sed "$CALLBACK_HOST")|g" \
    -e "s|__CALLBACK_PORT__|$(escape_sed "$CALLBACK_PORT")|g" \
    "$template_path" > "$output_path"
}

render_template \
  "$ROOT_DIR/templates/systemd/health-os-refresh.service.template" \
  "$OUTPUT_DIR/health-os-refresh.service"
render_template \
  "$ROOT_DIR/templates/systemd/health-os-refresh.timer.template" \
  "$OUTPUT_DIR/health-os-refresh.timer"
render_template \
  "$ROOT_DIR/templates/systemd/health-os-oura-callback.service.template" \
  "$OUTPUT_DIR/health-os-oura-callback.service"

printf 'rendered_unit=%s\n' "$OUTPUT_DIR/health-os-refresh.service"
printf 'rendered_unit=%s\n' "$OUTPUT_DIR/health-os-refresh.timer"
printf 'rendered_unit=%s\n' "$OUTPUT_DIR/health-os-oura-callback.service"
