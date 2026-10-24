# CLI reference

The canonical entrypoint is `node src/cli.js <command> --workspace PATH`. Existing operations have shell wrappers in `src/scripts/`; workspace inspection, migration, and profile commands use the CLI entrypoint.

| Command | Purpose |
| --- | --- |
| `init-workspace` | Create `.health-os/manifest.json`, a neutral profile card, and missing defaults |
| `workspace-inspect` | Inspect workspace schema and selected profile without writes |
| `workspace-migrate` | Deliberately add the workspace schema; supports `--dry-run` |
| `profile-show` | Return a bounded view of the selected Markdown profile |
| `profile-validate` | Validate selected profile metadata and document size |
| `context-add` / `context-query` | Record subjective HealthEvents or query bounded event history |
| `context-correct` / `context-delete` | Correct or tombstone an event with an expected revision |
| `context-revalidate-memory` | Revalidate derived-memory provenance after event changes |
| `timeline` | Query events alongside authoritative workout and recovery history |
| `prepare-training` | Return a bounded as-of training context without changing workspace domain data |
| `version` / `capabilities` | Report CLI and machine-contract versions and supported command subsets |
| `set-working-weight` | Set an exercise's initial working weight |
| `log-workout` | Store a workout from stdin or `--input FILE` |
| `next` | Print the next workout card |
| `today` | Print a daily brief and write `artifacts/today.md` |
| `why` | Explain the latest stored recovery decision |
| `weekly-summary` | Print a seven-day summary and write `artifacts/weekly.md` |
| `validate-daily-state` | Validate normalized recovery JSON |
| `ingest-daily-state` | Validate, score, and store daily recovery JSON |
| `connectors` / `sync-daily-source` | List connectors or fetch and ingest a provider day |
| `validate-wearable-observations` | Validate a HealthObservationSet v1 without workspace writes |
| `ingest-wearable-observations` / `wearable-observations` | Store idempotent observations or read bounded source/date sets |
| `normalize-oura-json` | Normalize an offline provider bundle without syncing |
| `oura-auth-url` / `oura-listen-callback` | Build an authorization URL or handle the local OAuth callback |
| `oura-exchange-code` / `oura-refresh-token` | Exchange or refresh credentials in an external token file |
| `oura-fetch-day` / `oura-sync-from-token` | Fetch a provider day or sync through the Oura token flow |
| `personal-raw-dir` / `personal-files-dir` | Print original-document or processed-note directories |
| `import-personal-file` | Copy a document into the workspace with `--file FILE` |
| `memory-update` | Compile a weekly evidence bundle with `--end-date YYYY-MM-DD` |
| `memory-context` | Retrieve relevant local Markdown with `--query TEXT` |
| `memory-lint` | Check memory metadata, provenance, and links |

## Output and input

Human-readable output remains the default. Add `--json` to any command for one compact, versioned envelope on stdout; command failures use the same envelope and still exit nonzero. Human-mode failures go to stderr. `version` and `capabilities --json` expose the CLI and envelope schema versions, command-specific stdin, idempotency, token, and write-lock capabilities. The JSON envelope and returned context are bounded; inspect its `truncation` field when present.

Use `--input-json` with `log-workout`, `ingest-daily-state`, `validate-daily-state`, `ingest-wearable-observations`, `validate-wearable-observations`, `context-add`, or `context-correct` to read a bare validated JSON payload object from stdin. Command options remain command-line flags; do not wrap payloads in a command/options object. Existing `--input FILE|-` behavior and shell wrappers remain available. The `--idempotency-key KEY` option is supported only by the workspace commands listed by `capabilities`; operation-journal replays return their original result, a key reused for different input fails with a conflict, and an interrupted pending request fails closed for inspection. Event mutations use a separate SQLite journal: an exact replay returns the current event state, replacement, or metadata-only tombstone. Event writes require an idempotency key, and correction, deletion, and supersession also require the expected revision.

## Writes and coordination

Workspace-writing CLI operations coordinate through a local lock and replace individual files atomically. This protects covered operations across Health OS processes, including init, migrations, reports, CSV/config updates, and memory writes. Token refresh uses a separate lock keyed by the canonical token-file path, so refreshes that share a token file serialize across workspaces. A killed process leaves a lock that requires manual inspection and removal; locks are never discarded by age. Multi-file CSV and raw-bundle writes are not transactions, so a crash between files can leave a partial operation. The local token lock cannot make provider-side token rotation plus local replacement a distributed transaction; if storage fails after a single-use refresh token rotates, reauthorization may be required. The CLI does not coordinate with external programs that edit workspace files directly.

Legacy read/result commands (`next`, `why`, `memory-context`, and `memory-lint`) may create missing workspace defaults while producing a result. Workspace-writing operations also initialize the files they need before applying the requested change. `workspace-inspect`, profile commands, `version`, `capabilities`, and validation commands do not initialize the workspace. `oura-fetch-day` reads the configured token under its file lock and only writes a data bundle when `--output-dir` is set.

`prepare-training` does not write domain data or seed missing files; its workspace lock and SQLite reads may create auxiliary WAL/SHM files. `context-query` and `timeline` on a missing event store do not scaffold a workspace. `workspace-migrate` writes unless `--dry-run` is enabled.

Payload examples, event lifecycle rules, preparation semantics, output bounds, and subprocess integration are in the [agent integration runbook](agent-integration-runbook.md). See [Oura setup](oura-oauth.md) for credential commands and [workspace boundaries](framework-and-workspace.md) for storage and migration details.
