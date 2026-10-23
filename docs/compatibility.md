# Framework compatibility guide

Use these checks when maintaining a fork, moving a workspace, or integrating an external caller. They cover the documented local contracts and do not require a provider account or deployed service.

## Runtime and source

- [ ] Use Node.js 22.13.0 or newer. Runtime dependencies are built into Node; no package install is required to run the CLI or examples. `package.json` is private, so this project is not an npm-published product or installer.
- [ ] Check the source version and machine contract with `node src/cli.js version --json` and `node src/cli.js capabilities --json`. Reject an unsupported JSON schema or an advertised command set that does not include the features the caller needs.
- [ ] Run the source compatibility check with `node --test tests/framework-compatibility.test.js`, then run `npm test` for the full local suite. Both checks use synthetic local state and should not require a provider account.
- [ ] Run `node examples/connectors/fixture-connector.mjs` and inspect `examples/generic-agent-caller.mjs` before replacing their synthetic inputs with a real workspace or connector.
- [ ] Review `git status --short` and the full source diff. Do not add `.health-os/`, provider bundles, tokens, personal documents, event text, operational logs, or backup archives to source history.

## Compatibility matrix

| Workspace found by `workspace-inspect` | Supported action |
| --- | --- |
| `uninitialized` | Create a new private workspace with `init-workspace`; select a non-default profile path explicitly when needed. |
| `versioned`, schema 1, selected profile valid | Continue with the current source. `init-workspace` preserves existing profile and configuration. Review source/workspace changes separately. |
| `unversioned` | Back up first; review `workspace-migrate --to 1 --dry-run`. Deliberately add schema 1, preserving the existing named card with `--profile` when applicable. |
| `invalid_profile_missing` or another invalid profile status | Restore or deliberately repair the selected profile. Init does not recreate a deleted card in a versioned workspace. |
| Unsupported manifest, EventStore, or observation-store schema | Stop and retain the original backup. This source version has no migration path from a later schema. |

Workspace initialization copies starter configuration only when a target is missing. It does not overwrite personalized values. A profile is manifest-selected and must remain under `.health-os/personal/files/`. EventStore identity uses the manifest-relative profile path, so root-directory moves are compatible, while renaming the selected profile path is not an event migration.

When upgrading the source while retaining a valid schema-1 workspace, run `workspace-inspect` and `profile-validate` first, then `init-workspace`. Initialization adds missing defaults such as `.health-os/config/preparation-policy.json` while preserving existing customized configuration and the selected Markdown card. It fails if the selected card is missing or invalid. `workspace-migrate --to 1` is for unversioned workspaces and reports that an already schema-1 workspace needs no migration.

## Moving or restoring a workspace

1. Make a coherent, encrypted backup using [workspace backup and restore](workspace-backup-restore.md). Stop Health OS and external writers; preserve SQLite WAL state with the database. Back up external credentials separately.
2. Confirm the source checkout and private workspace are distinct. Record the active workspace root, manifest-selected profile path, source version, command schema, and external token location without recording token contents.
3. On the target source, check `version`, `capabilities --json`, and `workspace-inspect`. Do not initialize, migrate, or seed a restored workspace before inspecting its manifest and file inventory.
4. Restore into a new directory and validate the exact selected profile and customized plan/policy/settings. Compare the authoritative CSVs, observation JSON, EventStore/review marker, personal documents, and memory against the backup.
5. Confirm external links, symlinks, and document references. Preserve the selected profile path exactly. Restore Oura credentials from the secure credential store and validate their configured path without exposing their contents.
6. Check event-derived memory only after the backup file inventory is complete. An exact DB/marker pair keeps its existing review state. If events changed or the pair is inconsistent, inspect current events and both `memory/wiki/` and `memory/evidence/`, update stale provenance, run `memory-lint`, and revalidate only the exact current event generation. `memory-lint` may initialize missing defaults, so recover missing files from the backup before running it. A pending or malformed state stays blocked for investigation.
7. Run one synthetic preparation with an explicit as-of cutoff using `node examples/generic-agent-caller.mjs "$HEALTH_OS_WORKSPACE" --as-of YYYY-MM-DD`. Review gaps and `workout.scheduled_only` before treating output as a recovery-supported recommendation.
8. Assign one owner for scheduled or manual writes. Direct external edits do not participate in Health OS locks. When changing owners, stop the current writer before starting the next writer.

## Generic caller contract

The canonical interface is `node src/cli.js <command> --workspace PATH --json`. A caller should check the envelope schema and command name, reject nonzero exits and `ok: false`, and inspect `truncation` and command-level gaps before using `data`. JSON failures are written to stdout and retain a nonzero process exit status. Do not treat a truncated health result as a usable decision. Pass only environment values the command needs; do not inherit provider tokens or model secrets into an unrelated read subprocess. `prepare-training` is read-only for domain data and does not accept an idempotency key; connector sync, event changes, workout writes, imports, and other state changes follow their advertised write and replay rules.

The example caller checks capabilities before preparation and prints a small summary. A production agent may pass the validated result to its internal reasoning step, subject to its own access and retention rules; the result can contain private profile text, event context, and health history. Avoid retaining it in shared process logs. Do not infer a decision when recovery is unavailable: the candidate is marked `UNAVAILABLE` and scheduled-only, with explicit gaps.

## Connector extension

- [ ] Keep the connector implementation deterministic and source-neutral; use a fixture first and mock all network/auth dependencies in tests.
- [ ] Register the connector explicitly in `src/health-data-connectors.js`. There is no dynamic plugin discovery. The built-in CLI lists and syncs only connectors registered in that source process.
- [ ] Declare exact observation schema and metric sets. Preserve provider provenance and real sample precision, represent unavailable measurements as `missing` or `unsupported`, and keep proprietary scores separate from physical measures.
- [ ] Check `decision_available`; success can store physical observations while recovery remains `UNAVAILABLE`. Do not manufacture readiness or sleep scores.
- [ ] Ensure direct library writes are serialized with the shared workspace lock. A caller using `syncDailyStateFromConnector()` directly should wrap the operation with `withWorkspaceLock(paths, ...)`; the CLI handles this around its sync command.
- [ ] Keep credentials outside the workspace and checkout. Raw provider bundles are sensitive and should be written only to a deliberately selected secure output path.

Connector field details and the complete synthetic registration example are in [Health Data Connectors](health-data-connectors.md).
