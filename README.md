# Health OS

Health OS is a CLI for training, recovery, and daily readiness decisions.

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
  memory/
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
./src/scripts/memory-update.sh --end-date 2026-07-19
./src/scripts/memory-context.sh --query "squat progression and recovery"
./src/scripts/memory-lint.sh --date 2026-07-19
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

## File-native Memory

Health OS maintains private, LLM-friendly memory under `.health-os/memory/`. This is a derived Markdown layer over authoritative workspace data, not a replacement for the CSV records, configuration, personal files, or reproducible artifacts.

The memory workflow deliberately uses ordinary files and lexical search rather than embeddings, a vector database, or a model-provider dependency:

```bash
# Compile a deterministic seven-day evidence bundle.
./src/scripts/memory-update.sh --end-date 2026-07-19

# Return bounded context for an external agent such as Hermes.
./src/scripts/memory-context.sh \
  --query "squat progression and recovery" \
  --max-pages 5 \
  --max-chars 12000

# Validate metadata, provenance, review dates, and Markdown links.
./src/scripts/memory-lint.sh --date 2026-07-19 --stale-days 90
```

`memory-update` does not perform LLM synthesis or medical inference. An external agent may maintain derived pages under `.health-os/memory/wiki/`, following `.health-os/memory/SCHEMA.md`. Observations, hypotheses, accepted personal rules, and general claims have distinct statuses; an accepted rule requires explicit human confirmation.

See `docs/memory.md` for the directory model and maintenance loop.

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

- `docs/agent-integration-runbook.md`
- `docs/memory.md`
- `docs/health-data-connectors.md`
- `docs/oura-oauth.md`
- `docs/personal-files.md`
