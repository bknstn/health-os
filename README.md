# Health OS

Health OS is a CLI-first health discovery app for training, recovery, and daily readiness decisions.

It keeps mutable state in a local workspace under `.health-os/`, uses deterministic rules for workout decisions, and can ingest normalized recovery data or Oura data through command-line workflows.

## What Lives Here

- training and recovery decision engine
- default program, exercise settings, and readiness rules
- CLI commands for logging, analysis, and artifact generation
- Oura OAuth, fetch, normalize, and sync helpers
- systemd templates for optional scheduled refresh on a VPS

## Runtime Model

Run the CLI from this repo, or through the shell wrappers in `scripts/`.

By default, the current directory is the health workspace. Set `HEALTH_OS_WORKSPACE` or pass `--workspace PATH` to keep state elsewhere:

```bash
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
./scripts/init-workspace.sh
```

The workspace contains `.health-os/config`, `.health-os/data`, and `.health-os/artifacts`. Oura tokens should stay outside the workspace, for example in `$HOME/.config/health-os/oura-token.json`.

## Commands

Initialize a workspace:

```bash
./scripts/init-workspace.sh
```

Log a workout from stdin:

```bash
cat workout.txt | ./scripts/log-workout.sh
```

Set a starting working weight:

```bash
./scripts/set-working-weight.sh --exercise squat --weight 80
```

Show the next workout:

```bash
./scripts/next-workout.sh
```

Generate today's brief:

```bash
./scripts/today.sh
```

Inspect the current decision:

```bash
./scripts/why.sh
```

Generate a weekly summary:

```bash
./scripts/weekly-summary.sh
```

Ingest normalized recovery data:

```bash
cat daily-state.json | ./scripts/ingest-daily-state.sh
```

Validate a normalized recovery payload:

```bash
cat daily-state.json | ./scripts/validate-daily-state.sh
```

Normalize raw Oura response JSON into the engine payload:

```bash
./scripts/normalize-oura-json.sh \
  --date 2026-04-13 \
  --readiness-file examples/oura/readiness-response.json \
  --sleep-file examples/oura/sleep-response.json \
  --heartrate-file examples/oura/heartrate-response.json
```

If a workspace already has prior recovery history, 28-day HRV and resting-HR baselines are computed automatically from `.health-os/data/recovery_snapshots.csv`.

## Oura Flow

Build an Oura authorization URL:

```bash
./scripts/oura-build-auth-url.sh --client-id "$OURA_CLIENT_ID" --redirect-uri "http://localhost:8787/callback"
```

Exchange an authorization code and write the token JSON to an external file:

```bash
./scripts/oura-exchange-code.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8787/callback" \
  --code "$OURA_CODE" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Fetch and ingest one Oura day directly into a workspace:

```bash
./scripts/oura-sync-from-token.sh \
  --date 2026-04-13 \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Listen for the server-side Oura callback and store the token file:

```bash
./scripts/oura-listen-callback.sh --token-file "$HOME/.config/health-os/oura-token.json"
```

## Runtime Setup

Start from the env template when you want a repeatable local or server setup:

```bash
cp examples/runtime/health-os.env.example ~/.config/health-os/runtime.env
./scripts/setup-runtime.sh --env-file ~/.config/health-os/runtime.env
```

Run tests:

```bash
npm test
```

More setup notes:

- Oura auth flow: `docs/oura-oauth.md`
- Full runtime runbook: `docs/runtime-setup.md`
- VPS deployment and systemd: `docs/vps-deployment.md`
