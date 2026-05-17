# Health OS

Health OS is a local CLI for training, recovery, and daily readiness decisions.

It owns deterministic health logic, workspace state, recovery ingestion, and provider connectors. It does not depend on a caller framework, dashboard, database service, or scheduler. Any external caller should use the CLI contract.

## Workspace

By default, commands use the current directory as the workspace. Pass `--workspace PATH` or set `HEALTH_OS_WORKSPACE` to keep state elsewhere.

```bash
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
./src/scripts/init-workspace.sh
```

Workspace data lives under `.health-os/`:

```text
.health-os/
  config/
  data/
  artifacts/
  personal/raw/
  personal/files/
```

Provider credentials and tokens should stay outside the workspace, for example in `$HOME/.config/health-os/oura-token.json`.

## CLI Contract

The canonical entrypoint is:

```bash
node src/cli.js <command> [--workspace PATH]
```

Shell wrappers in `src/scripts/` mirror the same commands.

Core commands:

```bash
./src/scripts/init-workspace.sh
cat workout.txt | ./src/scripts/log-workout.sh
./src/scripts/set-working-weight.sh --exercise squat --weight 80
./src/scripts/next-workout.sh
./src/scripts/today.sh
./src/scripts/why.sh
./src/scripts/weekly-summary.sh
```

Recovery ingestion:

```bash
cat daily-state.json | ./src/scripts/validate-daily-state.sh
cat daily-state.json | ./src/scripts/ingest-daily-state.sh
./src/scripts/sync-daily-source.sh --source oura --date 2026-04-13 --token-file "$HOME/.config/health-os/oura-token.json"
```

Personal files:

```bash
./src/scripts/personal-raw-dir.sh
./src/scripts/personal-files-dir.sh
./src/scripts/import-personal-file.sh --file medical-tests.pdf
./src/scripts/import-personal-file.sh --file medical-tests.md --kind processed
```

## Connector Boundary

Connectors fetch provider data and normalize it into the recovery contract validated by `src/recovery-contract.js`.

Stable external calls should use:

- `sync-daily-source --source <connector>` to fetch and ingest provider data
- `validate-daily-state` to check normalized payloads
- `ingest-daily-state` to store validated recovery data
- `today`, `why`, `next`, and `weekly-summary` for read-only outputs

Do not import provider adapters directly unless you are implementing or testing a connector.

## Oura

Build an authorization URL:

```bash
./src/scripts/oura-build-auth-url.sh --client-id "$OURA_CLIENT_ID" --redirect-uri "http://localhost:8787/callback"
```

Exchange an authorization code:

```bash
./src/scripts/oura-exchange-code.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8787/callback" \
  --code "$OURA_CODE" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Fetch, normalize, and ingest one Oura day:

```bash
./src/scripts/sync-daily-source.sh \
  --source oura \
  --date 2026-04-13 \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

## Development

```bash
npm test
```

Further docs:

- `docs/health-data-connectors.md`
- `docs/oura-oauth.md`
- `docs/personal-files.md`
