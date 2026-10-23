# Workspace backup, restore, and export

Health OS has no complete workspace export/import or backup/restore command. `import-personal-file` copies one document into the personal-file area; it is not a workspace restore. Back up and restore the private workspace with a secure filesystem or SQLite-aware backup tool, and keep the source checkout and external credentials as separate assets.

## What a restorable backup contains

Back up the complete `.health-os/` directory as one workspace unit. It contains the selected profile and manifest, customized configuration, authoritative CSV records, provider-neutral observation store, SQLite HealthEvents, review marker, idempotency journal, personal documents, generated artifacts, and Markdown memory. Keep unfamiliar files too; a fork or later version may add workspace-owned state.

The legacy workout and recovery records remain authoritative in `data/workout_sessions.csv`, `data/exercise_logs.csv`, `data/recovery_snapshots.csv`, and `data/daily_state.csv` (with `decision_log.csv` and other supporting files). The neutral wearable store is `data/wearable-observations.json`; subjective events are in `data/events.sqlite`; agent-maintained narrative and learned memory live in Markdown. Do not reconstruct one store from another during a file copy.

The manifest's `profile_path` is relative to `.health-os/` and is also the EventStore's profile identity. Moving the workspace directory keeps that identity stable. Preserve `manifest.json` and the exact selected profile filename; renaming the selected card can orphan the event identity even if the Markdown text stays the same. External absolute links or references inside documents, memory, or configuration may stop resolving after a move.

Oura tokens are outside the workspace by default. The active location is supplied through `OURA_TOKEN_FILE` or `--token-file`; the documented default path is `$HOME/.config/health-os/oura-token.json`. Back up credentials through a separate encrypted secret store or credential backup. Never put a token in the workspace archive, source checkout, shared export, or command history. A refresh-token backup can become invalid after the provider rotates it.

## Make a coherent backup

First stop every Health OS process that writes this workspace and any external editor or integration that edits files directly. Wait for active commands and the sibling workspace lock to clear. Its default name is `.health-os.health-os-write.lock` beside the `.health-os` directory. If a lock remains, inspect its owner and confirm that no process still uses the workspace; the CLI never removes a lock based on age alone.

SQLite uses write-ahead logging. Copying only `data/events.sqlite` while a connection is active can omit committed changes held in `events.sqlite-wal`. Prefer a backup product's SQLite-consistent snapshot or the SQLite backup API. If using a filesystem archive instead, stop all readers and writers, let each SQLite connection close, and capture the complete workspace directory in one consistent filesystem operation, keeping any remaining `events.sqlite`, `events.sqlite-wal`, and `events.sqlite-shm` files together. Do not copy the main database file by itself or copy database and sidecars at different times.

For example, after stopping readers and writers and confirming the lock is clear, a local archive can be created with restrictive default permissions. Choose a new destination; do not overwrite your only verified backup:

```bash
umask 077
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
export HEALTH_OS_BACKUP="$HOME/private-backups/health-os-2026-10-23.tar"
mkdir -p "$(dirname "$HEALTH_OS_BACKUP")"
tar -cpf "$HEALTH_OS_BACKUP" -C "$HEALTH_OS_WORKSPACE" .health-os
```

This command does not encrypt the archive. Store it on encrypted storage and use an encrypted channel for any transfer. Choose a filesystem snapshot or backup program that reads the tree as one point-in-time image when concurrent changes cannot be stopped. Keep the selected manifest/profile, event DB, review marker, and files under `.health-os/` together.

Review symlinks and external references before backup. Archive tools commonly preserve a symlink itself instead of including its target. The selected profile is required to resolve inside `personal/files/`, but other Markdown, memory, or configuration may refer to files outside the workspace. Record and back up any required external source separately, only when it is appropriate to retain it. Prefer stable relative references for portable notes; do not automatically follow arbitrary symlinks into home folders or mounted data.

## Restore to a new location

Restore into a new, empty directory first. Keep the existing workspace untouched until validation passes. Extract the archived `.health-os/` tree without recreating its manifest or seeding missing defaults, then inspect the restored files and permissions. For the archive above:

```bash
export HEALTH_OS_RESTORE="$HOME/.local/share/health-os/restore-check"
mkdir -p "$HEALTH_OS_RESTORE"
tar -xpf "$HEALTH_OS_BACKUP" -C "$HEALTH_OS_RESTORE"
node src/cli.js workspace-inspect --workspace "$HEALTH_OS_RESTORE"
node src/cli.js profile-validate --workspace "$HEALTH_OS_RESTORE"
```

Compare the restored file list and selected checksums with the backup before starting any writer. Then verify the active profile path, personalized configuration, CSV record counts, observation sets, event generation/review state, personal files, and memory pages. Restore the external token separately and confirm its current path through `OURA_TOKEN_FILE` or `--token-file`; do not move a stale refresh token over a newer one.

An exact coherent restore should retain `memory/event-review.json` alongside `data/events.sqlite`. If those files come from different snapshots, or the event rows changed after the Markdown pages were reviewed, memory retrieval must remain blocked until the mismatch is investigated. Review affected pages in `memory/wiki/` and `memory/evidence/`, correct their `health-event:<uuid>@<revision>` references, run `memory-lint`, and only then run `context-revalidate-memory --generation N` with the exact current generation. Revalidation checks provenance and event-store state; it is not a command to force a mixed or damaged backup into service.

After moving a workspace root, run `workspace-inspect`, `profile-validate`, `version`, and `capabilities --json` from the new source checkout. Confirm that any external symlink or absolute file reference still resolves. Keep one writer owner for the restored workspace; stop writes before switching between copies.

## Upgrading an existing schema-1 workspace

After updating the source checkout, make a coherent backup, then inspect the workspace and validate its selected profile with the updated CLI. Confirm that the manifest and selected profile are complete before initialization. On a complete schema-1 workspace with a valid profile, `init-workspace` creates only missing default files, including `config/preparation-policy.json`, and preserves files and customizations that already exist. It does not migrate an already-versioned workspace; `workspace-migrate --to 1` is for unversioned workspaces and reports that schema 1 needs no migration.

For example, with the updated checkout as the current directory:

```bash
node src/cli.js workspace-inspect --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js profile-validate --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js init-workspace --workspace "$HEALTH_OS_WORKSPACE"
```

If a restore is incomplete, recover the missing or damaged files from the coherent backup first, then inspect and validate again. Do not use initialization to fill gaps in a partial restore or recreate its manifest; that can separate the selected profile identity from event and review state.

## Older unversioned workspaces

A code upgrade does not migrate a workspace. For an existing `.health-os/` without `manifest.json`, take and verify a backup first, inspect it, then review the migration plan:

```bash
node src/cli.js workspace-inspect --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js workspace-migrate --to 1 --dry-run --workspace "$HEALTH_OS_WORKSPACE"
```

If the existing profile has a non-default name, pass that exact path as `--profile personal/files/<name>.md` to both the dry run and deliberate migration. The migration adds the schema-1 manifest and only creates a generic profile when the selected file is absent; it does not rewrite the existing Markdown or migrate workout/event records. Review the reported writes, then omit `--dry-run true` only when the plan is correct. Running `init-workspace` against a non-empty unversioned tree fails deliberately. A workspace already at schema 1 does not need this migration; this release has no migration path from later or unsupported schema versions.

Do not run `workspace-migrate` against a complete schema-1 restore. It reports that no migration is needed. Do not use `init-workspace` to replace a missing manifest during restore: inspect and repair from the coherent backup so EventStore profile identity and review state stay aligned.

## Backup versus shared export

A restorable backup is a private, complete, encrypted copy with its configuration, records, document inbox, event database, review state, and private memory intact. A shared export is a separate, deliberately limited artifact: remove personal identifiers, source documents, tokens, absolute home paths, private event text, and unnecessary provenance before sharing. Health OS does not generate or sanitize such an export. The repository's `.gitignore` is not an encryption or redaction boundary.
