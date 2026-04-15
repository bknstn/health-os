# Runtime Setup

This is the concrete runbook for wiring `health-os` into NanoClaw with Telegram and Oura, without storing secrets in the group workspace.

## 1. Prepare Environment

Copy the example file:

```bash
cp examples/runtime/health-os.env.example ~/.config/health-os/runtime.env
```

Edit `~/.config/health-os/runtime.env` and fill:

- `NANOCLAW_ROOT`
- `HEALTH_OS_ROOT`
- `HEALTH_OS_WORKSPACE`
- `TG_CHAT_JID`
- `OURA_CLIENT_ID`
- `OURA_CLIENT_SECRET`
- `OURA_REDIRECT_URI`
- `OURA_TOKEN_FILE`

Then validate the setup shape:

```bash
./scripts/check-runtime-env.sh --env-file ~/.config/health-os/runtime.env
```

At this point it is normal for `HEALTH_OS_WORKSPACE` and `OURA_TOKEN_FILE` to show up as optional missing paths if you have not registered the group or completed OAuth yet.

## 2. One-Shot Bootstrap

Once the env file is ready, the simplest path is:

```bash
./scripts/setup-runtime.sh --env-file ~/.config/health-os/runtime.env
```

That command:

- validates the required env
- registers the NanoClaw Telegram group
- copies the `CLAUDE.md` template if the group does not already have one
- initializes `.health-os/` in the group workspace
- prints the Oura authorization URL

Use `--skip-register` if the NanoClaw group is already registered and you only want to reinitialize the workspace or refresh the auth URL.

Use `--skip-auth-url` if you want to bootstrap the group before Oura credentials are ready:

```bash
./scripts/setup-runtime.sh --env-file ~/.config/health-os/runtime.env --skip-auth-url
```

For a real VPS deployment with systemd and server-side OAuth callback handling, use [vps-deployment.md](/Users/bknst/Projects/health-os/docs/vps-deployment.md).

## 3. Register The Telegram Health Group Manually

Source the runtime env and register the group in NanoClaw:

```bash
set -a
. ~/.config/health-os/runtime.env
set +a

./examples/nanoclaw/register-health-tracker.sh
```

Then copy the prompt template into the NanoClaw group folder and initialize the tracker workspace:

```bash
$HEALTH_OS_ROOT/scripts/init-workspace.sh --workspace "$HEALTH_OS_WORKSPACE"
```

## 4. Complete Oura OAuth

Build the authorization URL:

```bash
set -a
. ~/.config/health-os/runtime.env
set +a

./scripts/oura-build-auth-url.sh
```

Open the printed URL, approve access, then exchange the returned `code`:

```bash
./scripts/oura-exchange-code.sh --code "$OURA_CODE"
```

That writes the token JSON to `OURA_TOKEN_FILE`.

If you want strict OAuth state validation, set `OURA_STATE` before building the URL and use the same value when starting the callback listener.

## 5. Dry-Run Oura Sync

Pull one day and ingest it into the tracker workspace:

```bash
set -a
. ~/.config/health-os/runtime.env
set +a

./scripts/oura-sync-from-token.sh --date 2026-04-14 --output-dir temp
```

Then inspect the generated brief:

```bash
./scripts/today.sh --workspace "$HEALTH_OS_WORKSPACE"
./scripts/why.sh --workspace "$HEALTH_OS_WORKSPACE"
```

## 6. Add The Scheduled Sync

Use this template for the NanoClaw-side scheduled task:

```text
templates/nanoclaw/telegram_health-tracker/oura-daily-sync.sh
```

The scheduled task environment should include the same runtime env values from `runtime.env`.

## Notes

- `OURA_TOKEN_FILE` must stay outside `/workspace/group/`.
- `OURA_STRICT_HEARTRATE=false` is the pragmatic default. When heartrate is unavailable, sync can still proceed from sleep-derived resting HR.
- If `OURA_TOKEN_FILE` is still missing, finish step 3 before attempting the dry-run sync.
