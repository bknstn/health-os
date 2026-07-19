# Agent Integration Runbook

Use this runbook when an external AI agent, command runner, scheduler, or automation layer needs to operate Health OS. OpenClaw, Hermes, and similar agents should treat Health OS as a CLI service.

## Contract

Do:

- call `node src/cli.js <command>` or the matching shell wrapper in `src/scripts/`
- pass `--workspace PATH` or set `HEALTH_OS_WORKSPACE`
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

- Node.js 22 or newer
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
./src/scripts/init-workspace.sh
```

The workspace will contain `.health-os/` state. It is safe for agents to read outputs through CLI commands; they should not mutate workspace files directly.

## Command Surface

Discover connectors:

```bash
cd "$HEALTH_OS_REPO"
node src/cli.js connectors
```

Write commands:

- `init-workspace`
- `log-workout`
- `set-working-weight`
- `memory-update`
- `ingest-daily-state`
- `import-personal-file`
- `sync-daily-source`
- `oura-exchange-code`
- `oura-refresh-token`
- `oura-listen-callback`

Read-only commands:

- `connectors`
- `validate-daily-state`
- `personal-raw-dir`
- `personal-files-dir`
- `normalize-oura-json`
- `oura-auth-url`
- `oura-fetch-day`
- `today`
- `why`
- `weekly-summary`
- `next`
- `memory-context`
- `memory-lint`

`oura-fetch-day` is read-only for the Health OS workspace, but it calls the Oura API and may write raw JSON if `--output-dir` is provided.

## Daily Oura Sync

Use this when the agent has an existing Oura token file.

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/sync-daily-source.sh \
  --source oura \
  --date 2026-04-13 \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$OURA_TOKEN_FILE"
```

Expected behavior:

- refreshes the token first when a refresh token is present
- fetches Oura readiness, sleep, and heartrate collections
- normalizes the provider data into the recovery contract
- validates the normalized payload
- ingests the daily recovery state into `.health-os/`
- prints JSON describing the sync result

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

Build an authorization URL:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/oura-build-auth-url.sh \
  --client-id "$OURA_CLIENT_ID" \
  --redirect-uri "http://localhost:8787/callback"
```

Optionally listen for the OAuth callback and write the token file:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/oura-listen-callback.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8787/callback" \
  --token-file "$OURA_TOKEN_FILE"
```

If the agent receives an authorization code by another path, exchange it directly:

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/oura-exchange-code.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8787/callback" \
  --code "$OURA_CODE" \
  --token-file "$OURA_TOKEN_FILE"
```

Keep the token file outside `HEALTH_OS_WORKSPACE`.

## Error Handling

On any nonzero exit:

1. stop the current Health OS operation
2. preserve stdout and stderr in the agent run log
3. do not retry write commands blindly
4. report the failed command and error text to the supervising user or scheduler

Common cases:

- validation error: do not ingest the payload; fix the normalized JSON upstream
- missing token file: run the Oura authorization flow
- Oura `invalid_token` or `invalid_grant`: request re-authentication
- network failure during Oura sync: retry later with the same explicit date
- workspace permission failure: fix the workspace path or permissions before retrying

## Concurrency

Avoid running multiple write commands against the same `HEALTH_OS_WORKSPACE` at the same time. A scheduler or agent queue should serialize:

- `sync-daily-source`
- `ingest-daily-state`
- `log-workout`
- `set-working-weight`
- `import-personal-file`

Read-only brief commands may run after the write command completes.

## File-native memory

Health OS memory is private workspace state under `.health-os/memory/`. It is derived from authoritative data and artifacts and must not be copied into the agent's own long-term memory without preserving provenance.

```bash
cd "$HEALTH_OS_REPO"
./src/scripts/memory-update.sh --end-date 2026-07-19
./src/scripts/memory-context.sh --query "squat progression and recovery"
./src/scripts/memory-lint.sh --date 2026-07-19
```

`memory-update` is a serialized write command. It deterministically compiles a weekly evidence seed; it does not perform LLM synthesis. `memory-context` is read-only and lexical. `memory-lint` emits JSON and exits nonzero for invalid pages. Before an agent edits `memory/wiki/*.md`, it must read `.health-os/memory/SCHEMA.md`. Only the human owner may confirm an `accepted_rule`.

## Minimal OpenClaw or Hermes Task

An agent can implement a daily check as:

```text
1. cd $HEALTH_OS_REPO
2. run ./src/scripts/init-workspace.sh
3. run ./src/scripts/sync-daily-source.sh --source oura --date YYYY-MM-DD --client-id $OURA_CLIENT_ID --client-secret $OURA_CLIENT_SECRET --token-file $OURA_TOKEN_FILE
4. if sync succeeds, run ./src/scripts/today.sh --date YYYY-MM-DD
5. return the today output to the user
6. if sync fails, return the command, exit status, and error text
```

This keeps the AI agent outside Health OS internals while still allowing it to sync health data, update workspace state, and explain the recommendation.
