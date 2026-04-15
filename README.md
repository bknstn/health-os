# Health OS

Private repo for the NanoClaw-based health tracker.

## What Lives Here

- the training engine
- default program and readiness rules
- command-line tools for logging and analysis
- NanoClaw integration templates

## Runtime Model

This repo is mounted into a dedicated NanoClaw group as read-only code.

Mutable state is created in the group workspace under `.health-os/`.

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
./scripts/set-working-weight.sh --workspace /tmp/health-group --exercise squat --weight 80
```

Show the next workout:

```bash
./scripts/next-workout.sh
```

Generate today's brief:

```bash
./scripts/today.sh
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

Refresh a stored Oura token:

```bash
./scripts/oura-refresh-token.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Fetch and ingest one Oura day directly into a workspace:

```bash
./scripts/oura-sync-from-token.sh \
  --workspace /tmp/health-group \
  --date 2026-04-13 \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Bootstrap the NanoClaw runtime from an env file:

```bash
./scripts/setup-runtime.sh --env-file ~/.config/health-os/runtime.env
```

Listen for the server-side Oura callback and store the token file:

```bash
./scripts/oura-listen-callback.sh --token-file "$HOME/.config/health-os/oura-token.json"
```

Generate a weekly summary:

```bash
./scripts/weekly-summary.sh
```

Run tests:

```bash
npm test
```

More setup notes:

- Oura auth and runtime flow: `docs/oura-oauth.md`
- Telegram and NanoClaw runtime wiring: `docs/telegram-setup.md`
- Full runbook and env template: `docs/runtime-setup.md`
- VPS deployment and systemd: `docs/vps-deployment.md`
