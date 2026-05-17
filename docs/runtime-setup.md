# Runtime Setup

This runbook wires `health-os` as a standalone CLI app with a local workspace and optional Oura sync.

## 1. Prepare Environment

Copy the example file:

```bash
mkdir -p ~/.config/health-os
cp examples/runtime/health-os.env.example ~/.config/health-os/runtime.env
```

Edit `~/.config/health-os/runtime.env` and fill:

- `HEALTH_OS_ROOT`
- `HEALTH_OS_WORKSPACE`
- `OURA_CLIENT_ID`
- `OURA_CLIENT_SECRET`
- `OURA_REDIRECT_URI`
- `OURA_TOKEN_FILE`

Then validate the setup shape:

```bash
./scripts/check-runtime-env.sh --env-file ~/.config/health-os/runtime.env
```

It is normal for `HEALTH_OS_WORKSPACE` and `OURA_TOKEN_FILE` to show up as optional missing paths before workspace initialization and OAuth are complete.

## 2. Bootstrap The Workspace

Once the env file is ready:

```bash
./scripts/setup-runtime.sh --env-file ~/.config/health-os/runtime.env
```

That command:

- validates required env values
- creates `HEALTH_OS_WORKSPACE`
- initializes `.health-os/`
- prints the Oura authorization URL

Use `--skip-auth-url` if you want to bootstrap the workspace before Oura credentials are ready:

```bash
./scripts/setup-runtime.sh --env-file ~/.config/health-os/runtime.env --skip-auth-url
```

For a VPS deployment with systemd and server-side OAuth callback handling, use [vps-deployment.md](/Users/bknst/Projects/health-os/docs/vps-deployment.md).

## 3. Complete Oura OAuth

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

That writes token JSON to `OURA_TOKEN_FILE`.

If you want strict OAuth state validation, set `OURA_STATE` before building the URL and use the same value when starting the callback listener.

## 4. Dry-Run Oura Sync

Pull one day and ingest it into the health workspace:

```bash
set -a
. ~/.config/health-os/runtime.env
set +a

./scripts/oura-sync-from-token.sh --date 2026-04-14 --output-dir temp
```

Then inspect the generated outputs:

```bash
./scripts/today.sh
./scripts/why.sh
./scripts/weekly-summary.sh
```

## 5. Scheduled Refresh

For a server or always-on host, use the systemd templates documented in [vps-deployment.md](/Users/bknst/Projects/health-os/docs/vps-deployment.md). The scheduled refresh runs Oura sync and regenerates `.health-os/artifacts/today.md` and `.health-os/artifacts/weekly.md`.

## Notes

- `OURA_TOKEN_FILE` should stay outside `HEALTH_OS_WORKSPACE`.
- `OURA_STRICT_HEARTRATE=false` is the pragmatic default. When heartrate is unavailable, sync can still proceed from sleep-derived resting HR.
- If `OURA_TOKEN_FILE` is missing, complete OAuth before attempting Oura sync.
