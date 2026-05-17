# Health OS

Health OS is a CLI-first health discovery app for training, recovery, and daily readiness decisions.

It keeps mutable state in a local workspace under `.health-os/`, uses deterministic rules for workout decisions, and can ingest normalized recovery data from provider connectors such as Oura.

## What Lives Here

- training and recovery decision engine
- default program, exercise settings, and readiness rules
- CLI commands for logging, analysis, and artifact generation
- health data connector interface for wearable and recovery data sources
- Oura OAuth, fetch, normalize, and sync connector

## Runtime Model

Run the CLI from this repo, or through the shell wrappers in `src/scripts/`.

By default, the current directory is the health workspace. Set `HEALTH_OS_WORKSPACE` or pass `--workspace PATH` to keep state elsewhere:

```bash
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
./src/scripts/init-workspace.sh
```

The workspace contains `.health-os/config`, `.health-os/data`, `.health-os/artifacts`, `.health-os/personal/raw`, and `.health-os/personal/files`. Provider tokens should stay outside the workspace, for example in `$HOME/.config/health-os/oura-token.json`.

Use `.health-os/personal/raw` for original user uploads in any format. Use `.health-os/personal/files` for processed Markdown or text files that are ready for agents and tools to read. The repo-level `raw/` folder is legacy source material; runtime uploads belong in the workspace.

## Commands

Initialize a workspace:

```bash
./src/scripts/init-workspace.sh
```

Log a workout from stdin:

```bash
cat workout.txt | ./src/scripts/log-workout.sh
```

Set a starting working weight:

```bash
./src/scripts/set-working-weight.sh --exercise squat --weight 80
```

Show the next workout:

```bash
./src/scripts/next-workout.sh
```

Generate today's brief:

```bash
./src/scripts/today.sh
```

Inspect the current decision:

```bash
./src/scripts/why.sh
```

Generate a weekly summary:

```bash
./src/scripts/weekly-summary.sh
```

Ingest normalized recovery data:

```bash
cat daily-state.json | ./src/scripts/ingest-daily-state.sh
```

Validate a normalized recovery payload:

```bash
cat daily-state.json | ./src/scripts/validate-daily-state.sh
```

Show the raw upload folder for the current workspace:

```bash
./src/scripts/personal-raw-dir.sh
```

Show the processed personal files folder for the current workspace:

```bash
./src/scripts/personal-files-dir.sh
```

Import an original user upload into `.health-os/personal/raw`:

```bash
./src/scripts/import-personal-file.sh --file medical-tests.pdf
```

Import an agent-ready Markdown file into `.health-os/personal/files`:

```bash
./src/scripts/import-personal-file.sh --file medical-tests.md --kind processed
```

List available health data connectors:

```bash
node src/cli.js connectors
```

Sync one provider day through the connector interface:

```bash
./src/scripts/sync-daily-source.sh \
  --source oura \
  --date 2026-04-13 \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Normalize raw Oura response JSON into the engine payload:

```bash
./src/scripts/normalize-oura-json.sh \
  --date 2026-04-13 \
  --readiness-file examples/oura/readiness-response.json \
  --sleep-file examples/oura/sleep-response.json \
  --heartrate-file examples/oura/heartrate-response.json
```

If a workspace already has prior recovery history, 28-day HRV and resting-HR baselines are computed automatically from `.health-os/data/recovery_snapshots.csv`.

## Connector Boundary

Health OS is intentionally independent of agents, MCP tools, dashboards, or schedulers. External consumers should use the stable commands and normalized recovery contract instead of importing Oura-specific code:

- harvest provider data with `sync-daily-source --source <connector>`
- validate external payloads with `validate-daily-state`
- ingest already-normalized payloads with `ingest-daily-state`
- read briefs through `today`, `why`, and `weekly-summary`

See `docs/health-data-connectors.md` for the connector contract and extension notes for sources such as Whoop or other wearables.

## Oura Flow

Build an Oura authorization URL:

```bash
./src/scripts/oura-build-auth-url.sh --client-id "$OURA_CLIENT_ID" --redirect-uri "http://localhost:8787/callback"
```

Exchange an authorization code and write the token JSON to an external file:

```bash
./src/scripts/oura-exchange-code.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8787/callback" \
  --code "$OURA_CODE" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Fetch and ingest one Oura day directly into a workspace:

```bash
./src/scripts/oura-sync-from-token.sh \
  --date 2026-04-13 \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

`oura-sync-from-token` is kept for compatibility. New integrations should call `sync-daily-source --source oura`; both paths use the same Oura connector internally.

Listen for the server-side Oura callback and store the token file:

```bash
./src/scripts/oura-listen-callback.sh --token-file "$HOME/.config/health-os/oura-token.json"
```

Run tests:

```bash
npm test
```

More setup notes:

- Oura auth flow: `docs/oura-oauth.md`
- Health data connectors: `docs/health-data-connectors.md`
- Personal file uploads: `docs/personal-files.md`
