# Agent Integration Runbook

Use this runbook when an external AI agent, command runner, scheduler, or automation layer needs to operate Health OS. Callers should treat Health OS as a CLI service boundary.

## Contract

Do:

- call `node src/cli.js <command>` or a matching shell wrapper where one exists in `src/scripts/`
- pass `--workspace PATH` to direct Node commands; shell wrappers also honor `HEALTH_OS_WORKSPACE`
- keep provider credentials and tokens outside the workspace
- read command stdout as the integration result
- treat nonzero exit status as a failed operation

Do not:

- import `src/*` modules from the agent runtime
- write provider credentials into `.health-os/`
- edit `.health-os/data/*` directly
- ingest unvalidated externally normalized payloads
- depend on Oura-specific internals unless implementing a connector

## Runtime Requirements

- Node.js 22.13.0 or newer (`node:sqlite` is no longer behind an experimental startup flag)
- repo checkout available on the machine running the agent
- writable workspace directory for Health OS state
- provider credentials or token files available outside the workspace when syncing live sources

Recommended paths:

```bash
export HEALTH_OS_REPO="$HOME/Projects/health-os"
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
export OURA_TOKEN_FILE="$HOME/.config/health-os/oura-token.json"
```

Initialize the workspace once:

```bash
cd "$HEALTH_OS_REPO"
node src/cli.js init-workspace --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js workspace-inspect --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js profile-validate --workspace "$HEALTH_OS_WORKSPACE"
```

The workspace will contain a versioned `.health-os/` manifest, generic profile template, and engine state. Personalize `.health-os/personal/files/profile.md` after initialization. Agents may maintain processed Markdown and derived pages in `memory/wiki/`, following their provenance and memory-schema rules. Preserve original uploads and generated evidence; do not edit `.health-os/data/` directly. The [framework and workspace guide](framework-and-workspace.md) describes clone, personalization, and migration.

For an existing unversioned workspace, first run `workspace-inspect`. Review `workspace-migrate --to 1 --dry-run` before the explicit `workspace-migrate --to 1` operation. Supply `--profile personal/files/<name>.md` to deliberately select an existing noncanonical card. Migration validates that card before writing a manifest and never rewrites its Markdown. If the selected path is missing in an unversioned workspace, deliberate migration creates the neutral template there. A missing profile in an already versioned workspace or invalid metadata is an error; init will not recreate a deleted card.

`workspace-inspect`, `profile-show`, and `profile-validate` are read-only and do not initialize the workspace. `workspace-migrate` is read-only with `--dry-run true` and writes when `--dry-run` is false or omitted. Init, migration, and other covered workspace writers use the shared lock and atomic per-file replacements described below.

## Machine contract and stream behavior

Discover the running implementation before relying on optional features:

```bash
cd "$HEALTH_OS_REPO"
node src/cli.js version
node src/cli.js capabilities --json
```

`capabilities` reports the CLI JSON schema version, workspace schema versions, all command names, exact command subsets for JSON stdin, idempotency and lock coordination, conditional external/token writes, supported payload shapes, and output limits. Any listed command accepts `--json`. Success envelopes include `schema_version`, `command`, `ok`, and `data`; failures include `schema_version`, `command`, `ok: false`, and `error`. Either may include `idempotency` or `truncation`. Command failures also use stdout and still exit 1; human-mode errors use stderr. Success output uses stdout in both modes. JSON output is bounded to 256 KiB including the newline; text fields are bounded by code points (12,000 by default), arrays and object keys are limited, and `truncation` identifies clipped values. Profile display has its own `--max-chars` bound and reports returned and total character counts.

For JSON payloads, use `--input-json` with `log-workout`, `ingest-daily-state`, `validate-daily-state`, `ingest-wearable-observations`, `validate-wearable-observations`, `context-add`, or `context-correct`. It reads one bare payload object from stdin, while command options remain flags. Event and observation-ingestion commands require `--input-json` before reading stdin, so a missing flag fails without waiting for input:

```bash
cat normalized-recovery.json | node src/cli.js ingest-daily-state \
  --json --input-json --workspace "$HEALTH_OS_WORKSPACE" --date 2026-10-23
```

For workout logs, bare validated workout JSON uses the shape reported by `capabilities`; the existing text `/log` format remains supported through `--input FILE|-` and wrappers. `--input-json` is not a command-options wrapper. With the existing `log-workout` wrapper, its injected `--input -` is accepted when paired with `--input-json`.

The workspace operation journal supports `--idempotency-key KEY` for `log-workout`, `set-working-weight`, `next`, `ingest-daily-state`, `import-personal-file`, `sync-daily-source`, `oura-sync-from-token`, `today`, `why`, `weekly-summary`, `memory-update`, `memory-context`, and `memory-lint`. A matching completed request returns its original result and exit status. Reusing a key with different effective options, dates, payload/file bytes, or imported filename fails with a conflict. `context-add`, `context-correct`, and `context-delete` instead use the EventStore's SQLite request journal: an exact retry returns the current event state, which can be a later corrected/replacement event or a metadata-only tombstone. Capture identity also prevents a new key from recreating a corrected, superseded, or deleted source fragment. A pending or unreadable journal record fails closed. Init, migration, token rotation, and memory revalidation do not accept operation-journal keys.

`prepare-training` is logically read-only and does not accept an idempotency key. It requires an existing initialized workspace and does not write domain data, seed missing files, or mutate memory-review state. Workspace locking and SQLite reads can create or update auxiliary WAL/SHM files. Use the same `--json` envelope from a terminal or a generic subprocess wrapper:

```bash
node src/cli.js prepare-training \
  --as-of 2026-10-23 \
  --workspace "$HEALTH_OS_WORKSPACE" --json

# An explicit session and allowlisted substitutions are optional.
node src/cli.js prepare-training \
  --as-of 2026-10-23T12:00:00Z --session B \
  --substitute deadlift=squat,barbell_row=bench_press \
  --workspace "$HEALTH_OS_WORKSPACE" --json
```

[`examples/generic-agent-caller.mjs`](../examples/generic-agent-caller.mjs) is a runnable generic subprocess wrapper. It first checks `capabilities`, invokes `prepare-training`, validates the envelope and domain schema versions, rejects truncated results, and prints only a small summary. It gives the subprocess a minimal environment instead of inheriting provider credential variables. Run it against an initialized synthetic or private workspace with an explicit cutoff:

```bash
node examples/generic-agent-caller.mjs "$HEALTH_OS_WORKSPACE" --as-of 2026-10-23 --session A
```

The wrapper intentionally avoids printing profile text, event payloads, or history. A real agent can pass the validated `data` object to its internal reasoning step only after checking its own access and retention rules. Treat the returned JSON as private health context; do not write it to shared logs. Do not use `data` when the envelope reports truncation or when recovery is unavailable. See the [compatibility guide](compatibility.md) for integration and workspace-move checks.

The result includes `profile`, `session_selection`, `workout`, `recovery`, `subjective`, `memory`, `gaps`, and `provenance`. `--session` is an explicit plan day-type override when the private policy permits it. Each substitution must match an entry in `substitutions.allowed`; substitutions are capped by `max_per_session`. The default allowlist is empty, so the example requires adding both `deadlift=squat` and `barbell_row=bench_press` to the private policy first.

`--as-of YYYY-MM-DD` includes the whole UTC calendar day. `--as-of RFC3339` uses the exact represented instant. Future rows are filtered before bounded result limits apply. A same-day day-only workout or event cannot be placed before an exact-time cutoff, so it is excluded from time-sensitive history; an interval crossing that cutoff is also excluded. The profile and configuration come from the current workspace snapshot, because they are not versioned historical records.

Session assignment uses the configured weekday map when present and otherwise alternates after the latest completed session at or before the cutoff. The policy can allow `--session` to override that choice. Approved substitutions change the selected plan entries and use the replacement exercise's own settings and history. The existing `next` and `today` commands retain their legacy behavior.

Recovery is available only when the selected inputs are fresh and the required baseline samples meet the configured window and minimum day count. A scored observation set can drive preparation when it includes fresh HRV, resting heart rate, readiness and sleep scores plus adequate baselines from that same source. Physical-only or scoreless observations remain useful context but cannot produce a recovery decision. Legacy daily-state rows can also drive preparation when the private policy explicitly permits their unscoped baselines; that option is disabled by default. The result never copies a stale prior decision or treats a missing baseline as established.

When recovery is unavailable, `workout.scheduled_only` is `true` and `workout.mode` is `UNAVAILABLE`; the exercise card is a schedule candidate, not a recovery-supported recommendation. `recovery.decision.status` and `gaps` explain why no decision was made. A missing selected profile is an explicit profile gap when the workspace manifest is valid, while a missing or invalid preparation policy and other required configuration are command errors.

Only the latest recent, active, low-uncertainty `fact` for a configured subjective event type can apply that type's validated value-range rule. Repeated check-ins do not stack a set adjustment; a later eligible fact, including a normal value, replaces the earlier one. Pending and high/unknown-uncertainty events appear as signals and do not apply adjustments. These are configured training inputs, not a medical assessment.

Preparation checks the EventStore and derived-memory review generation before reading memory. If review is pending, inconsistent, or any Markdown page has stale event provenance, `memory.status` is `blocked`, memory content is omitted, and a gap explains the condition. Direct active HealthEvents remain separately identified. `memory.status` can also be `available`, `empty`, or `missing`; callers should only use returned memory when its status permits it. The domain response is bounded to 64 KiB: narrative context is shortened with an explicit gap when needed, and the command returns an output-limit error if the bounded result still cannot fit rather than emitting a clipped decision. The common JSON envelope is also bounded; inspect `truncation` when present.

## HealthEvents and timeline

The EventStore is scoped to the explicitly selected workspace profile. `context-add` and `context-correct` accept a bare HealthEvent v1 object on stdin; omit `event_id` on add to let Health OS generate it. These examples use synthetic values:

```bash
node src/cli.js context-add --json --input-json \
  --workspace "$HEALTH_OS_WORKSPACE" \
  --idempotency-key capture:message-42:0 <<'JSON'
{
  "schema_version": 1,
  "event_type": "strength.set",
  "occurred": {
    "start": "2026-10-23T09:00:00+02:00",
    "end": null,
    "precision": "minute",
    "timezone": "Europe/Warsaw"
  },
  "data": {"exercise": "squat", "weight_kg": 50, "reps": 5},
  "source": {"kind": "manual", "ref": "message-42", "fragment_id": "0"},
  "extraction_version": "manual-v1",
  "epistemic_status": "fact",
  "uncertainty": {"level": "low", "note": null}
}
JSON
```

Query events by `--since`, `--through`, comma-separated `--type`/`--source`, and `--limit` (1–50). An exact `--event-id` query automatically includes inactive events and tombstones; list queries include them only with `--include-inactive true`. Query results sort newest first; `timeline` returns the oldest matching events first to compose them with legacy CSV records. Both are read-only and do not create a missing event store. Unknown-time events are not included when a date filter is present; interval bounds match when they overlap the inclusive UTC date range.

To correct an event, submit its same `event_id` and source identity with the expected revision reported by `context-query`:

```bash
cat corrected-event.json | node src/cli.js context-correct --json --input-json \
  --workspace "$HEALTH_OS_WORKSPACE" --event-id EVENT_UUID --expected-revision 1 \
  --idempotency-key correction:EVENT_UUID:2
```

`context-add --supersedes-event-id EVENT_UUID --expected-revision 1` creates a new event while marking the old one superseded. `context-delete --event-id EVENT_UUID --expected-revision N --idempotency-key delete:EVENT_UUID:N` tombstones the event. Old capture replays return the current replacement or a metadata-only tombstone; they do not restore prior event text. Deletion scrubs the live row and revision digests, but does not rewrite SQLite WALs or external backups.

Every successful event mutation makes derived memory pending. Update the affected Markdown pages in `memory/wiki/` and `memory/evidence/`, keep `health-event:UUID@REVISION` references current, then run `context-revalidate-memory --generation N` using the exact generation from the command result. `memory-context` fails closed until revalidation; `memory-lint` reports pending or stale references. The gate is workspace-wide. If a write crashes after the marker but before SQLite commit, a later write or explicit revalidation rebuilds the one-generation-ahead marker from the database; malformed or more divergent state stays blocked for investigation.

## Wearable observations

HealthObservationSet v1 keeps physical readings in `physical_metrics` and optional provider scores in `proprietary_scores`. Each metric carries explicit missingness, units, a source reference, and either an exact sample timestamp, a day label, or unknown time. Freshness is reported separately; the set-level assessment does not make all metrics equally fresh. Baseline coverage reports distinct, source-scoped sample days and can remain partial or unavailable.

Validate a synthetic or externally normalized set before writing. Validation is read-only and does not initialize the selected workspace:

```bash
cat observation-set.json | node src/cli.js validate-wearable-observations \
  --json --input-json --workspace "$HEALTH_OS_WORKSPACE"
```

Ingest it with a stable request key. The command validates before acquiring the write lock, then atomically replaces the full set for that source and date:

```bash
cat observation-set.json | node src/cli.js ingest-wearable-observations \
  --json --input-json --workspace "$HEALTH_OS_WORKSPACE" \
  --idempotency-key sensor:2026-10-23
```

Read stored sets with `wearable-observations --source <id> --date YYYY-MM-DD --json`. Reimport replaces the full source/date set, so a value can become missing without a stale value being merged back. Source-specific baselines count distinct known sample days in UTC and reject mixed units. Legacy recovery CSV history has no dependable connector identity and is not combined into observation baselines.

## Command Surface

Discover connectors:

```bash
cd "$HEALTH_OS_REPO"
node src/cli.js connectors
```

Workspace writes and legacy seed commands:

- `init-workspace`
- `workspace-migrate`
- `log-workout`
- `set-working-weight`
- `memory-update`
- `ingest-daily-state`
- `ingest-wearable-observations`
- `import-personal-file`
- `sync-daily-source`
- `oura-exchange-code`
- `oura-refresh-token`
- `oura-listen-callback`
- `today` (writes `artifacts/today.md`)
- `why` (may seed missing defaults)
- `weekly-summary` (writes `artifacts/weekly.md`)
- `next` (may seed missing defaults)
- `memory-context` / `memory-lint` (may seed missing defaults)
- `context-add` / `context-correct` / `context-delete` (versioned HealthEvent writes)
- `context-revalidate-memory` (explicitly clears the derived-memory event-review gate)

Read-only, validation, and external fetch commands:

- `version` / `capabilities`
- `workspace-inspect` (read-only)
- `profile-show` (read-only; bounded Markdown view)
- `profile-validate` (read-only)
- `prepare-training` (read-only; bounded as-of profile/history/recovery/event/memory context)
- `connectors`
- `validate-daily-state`
- `validate-wearable-observations`
- `wearable-observations`
- `context-query` / `timeline` (bounded, read-only event/CSV queries)
- `personal-raw-dir`
- `personal-files-dir`
- `normalize-oura-json`
- `oura-auth-url`
- `oura-fetch-day` (provider read; token file is read under lock; `--output-dir` writes external files)

Version/capability, inspect/profile, validation, `prepare-training`, connector-listing, directory, normalization, and authorization-URL reads do not initialize a workspace. The legacy read/result commands listed above may seed missing defaults; workspace-writing operations also initialize the defaults they need. `workspace-migrate` writes unless dry-run is enabled. `oura-fetch-day` calls the Oura API; it writes raw JSON only when `--output-dir` is provided.

## Daily Oura Sync

Use this when the agent has an existing Oura token file.

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/sync-daily-source.sh \
  --source oura \
  --date 2026-04-13 \
  --token-file "$OURA_TOKEN_FILE"
```

Expected behavior:

- refreshes the token first when a refresh token is present
- fetches Oura readiness, sleep, and heartrate collections
- normalizes provider data into HealthObservationSet v1 and, when available, the legacy recovery contract
- validates and stores observations in `.health-os/data/wearable-observations.json`
- ingests legacy daily recovery only when the connector returns a complete normalized recovery payload
- prints JSON describing the sync result

Check `decision_available` before serving a training recommendation. An observation-only sync returns `mode: "UNAVAILABLE"` and `score: null`; it does not create a legacy daily recovery decision. A legacy daily-state row from an earlier sync can remain. `today` and `next` continue to use the legacy engine. `prepare-training` can make a decision from either fresh, sufficiently covered legacy data allowed by policy or a scored observation set with adequate same-source baselines. Physical-only observations do not imply readiness.

If the agent is running on a schedule, run this once per target calendar day. Prefer passing an explicit `--date YYYY-MM-DD` instead of relying on the host clock.

## External Payload Ingestion

Use this when another service already normalized daily health data into the Health OS recovery contract.

Validate first:

```bash
cd "$HEALTH_OS_REPO"
cat daily-state.json | ./src/scripts/validate-daily-state.sh
```

Ingest only after validation succeeds:

```bash
cd "$HEALTH_OS_REPO"
cat daily-state.json | ./src/scripts/ingest-daily-state.sh
```

The normalized payload shape is illustrated by:

- `examples/recovery/normalized-good-day.json`
- `examples/recovery/normalized-bad-day.json`

Validation prints the normalized JSON on success and exits nonzero on invalid input.

## Agent Briefs

Use these commands when the agent needs to explain the current recommendation or produce a user-facing brief.

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/today.sh --date 2026-04-13
./src/scripts/why.sh
./src/scripts/weekly-summary.sh --end-date 2026-04-13
./src/scripts/next-workout.sh
```

`today` returns the daily recovery decision and next workout card. `why` explains the latest decision. `weekly-summary` summarizes the seven-day window ending on `--end-date`. `next-workout` returns the next training card without requiring the agent to inspect config files.

## Personal Health Files

Original uploads belong in `.health-os/personal/raw/`. Processed Markdown or text belongs in `.health-os/personal/files/`.

Get target directories:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/personal-raw-dir.sh
./src/scripts/personal-files-dir.sh
```

Import an original upload:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/import-personal-file.sh --file lab-results.pdf
```

Import processed text:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/import-personal-file.sh --file lab-results.md --kind processed
```

Agents should preserve provenance: keep original files unchanged in `personal/raw/`, and place extracted or summarized text in `personal/files/`.

## Oura Authorization

Use this when the token file does not exist or Oura reports re-authentication is required.

Set `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI`, and `OURA_TOKEN_FILE` in the environment. Generate one `OURA_STATE` value for the attempt and pass the same value to the URL builder and callback listener. Keep credentials out of command arguments and logs; see the full [OAuth setup guide](oura-oauth.md).

Build an authorization URL:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/oura-build-auth-url.sh \
  --redirect-uri "http://localhost:8787/callback"
```

Optionally listen for the OAuth callback and write the token file:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/oura-listen-callback.sh \
  --redirect-uri "http://localhost:8787/callback" \
  --token-file "$OURA_TOKEN_FILE"
```

If the agent receives an authorization code by another path, verify the returned state and supply the code as `OURA_CODE` in the environment. The command stores the token file and prints only storage metadata by default:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/oura-exchange-code.sh \
  --redirect-uri "http://localhost:8787/callback" \
  --token-file "$OURA_TOKEN_FILE"
```

Keep the token file outside `HEALTH_OS_WORKSPACE`.

## Error Handling

On any nonzero exit:

1. stop the current Health OS operation
2. inspect stdout and stderr locally; redact credentials and health data before retaining or sharing logs
3. do not retry write commands blindly
4. report the failed command and error text to the supervising user or scheduler

Common cases:

- validation error: do not ingest the payload; fix the normalized JSON upstream
- missing token file: run the Oura authorization flow
- Oura `invalid_token` or `invalid_grant`: request re-authentication
- network failure during Oura sync: retry later with the same explicit date
- workspace permission failure: fix the workspace path or permissions before retrying

## Concurrency

Commands that use the same workspace automatically acquire a local process lock. Its name is based on the canonical physical `.health-os` path, so workspace symlink aliases coordinate too. Token-file operations use a separate lock based on the canonical token-file path; this serializes refreshes even when consumers select different workspaces. Raw output directories shared by `oura-fetch-day` and connector syncs use a path lock as well. The token lock is released before waiting for an output-directory lock.

Covered workspace writes and legacy seed operations include:

- `sync-daily-source`
- `oura-sync-from-token`
- `init-workspace` and write-mode `workspace-migrate`
- `ingest-daily-state`
- `log-workout`
- `set-working-weight`
- `import-personal-file`
- `next`, `why`, `memory-context`, and `memory-lint` when seeding missing files
- `today`
- `weekly-summary`
- `memory-update`

Each file replacement uses a sibling temporary and atomic rename. A successful write of one file does not make an operation spanning multiple CSVs or raw-bundle files transactional; a process crash between replacements can leave a partial legacy update or bundle. The local token lock serializes callers, but it cannot make the remote OAuth refresh and local token-file replacement a distributed transaction. If a process or file-system failure occurs after the provider rotates a single-use refresh token but before the replacement is durable, reauthorization may be required. Lock coordination applies to Health OS CLI operations, not arbitrary external editors or scripts writing directly into the workspace.

Locks are deliberately not removed by age. If a process is killed while holding a lock, the next command fails closed and reports the lock path and owner metadata. Confirm the recorded process is gone and no Health OS operation is active before manually removing that lock directory. Do not remove a lock simply because it appears old. The workspace lock is a sibling of `.health-os`; token and raw-output locks are siblings of their protected paths.

Routine `oura-exchange-code` and `oura-refresh-token` calls require a token-file destination (`--token-file` or `OURA_TOKEN_FILE`) so a rotated token is not discarded. Without a destination, set `--export-token true` only when deliberately handling the returned token contents. Normal output contains storage metadata, not access or refresh token values. Keep token files outside the health workspace.

## File-native memory

Health OS memory is private workspace state under `.health-os/memory/`. It is derived from authoritative data and artifacts and must not be copied into the agent's own long-term memory without preserving provenance.

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/memory-update.sh --end-date 2026-07-19
./src/scripts/memory-context.sh --query "squat progression and recovery"
./src/scripts/memory-lint.sh --date 2026-07-19
```

`memory-update` is a coordinated write command. It deterministically compiles a weekly evidence seed; it does not perform LLM synthesis. `memory-context` performs lexical retrieval and may seed missing workspace defaults. `memory-lint` checks pages, may seed missing defaults, and exits nonzero for invalid pages. Before an agent edits `memory/wiki/*.md`, it must read `.health-os/memory/SCHEMA.md`. Only the human owner may confirm an `accepted_rule`.

## Minimal agent subprocess example

An agent can implement a daily check as:

```text
1. cd $HEALTH_OS_REPO
2. run ./src/scripts/init-workspace.sh
3. run ./src/scripts/sync-daily-source.sh --source oura --date YYYY-MM-DD --token-file $OURA_TOKEN_FILE (client credentials come from the environment)
4. if sync succeeds, run ./src/scripts/today.sh --date YYYY-MM-DD
5. return the today output to the user
6. if sync fails, return the command, exit status, and error text after redacting credentials and personal data
```

This keeps the AI agent outside Health OS internals while still allowing it to sync health data, update workspace state, and explain the recommendation.
