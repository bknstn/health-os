# Telegram Setup

This repo does not run Telegram itself. Telegram stays in the NanoClaw runtime, and `health-os` is mounted in as read-only command logic.

## Required Inputs

- Telegram bot token in the NanoClaw runtime secret store
- target chat or group id
- mounted `health-os` repo at `/workspace/extra/health-os`
- dedicated NanoClaw group folder, for example `telegram_health-tracker`

## Runtime Steps

1. Enable Telegram in the NanoClaw runtime and inject the bot token there, not in this repo.
2. Add the bot to the target private chat or group.
3. Register the health tracker group with `requiresTrigger=false`.
4. Add the read-only mount for this repo.
5. Copy the template prompt from `templates/nanoclaw/telegram_health-tracker/CLAUDE.md` into the group folder.
6. Initialize the mutable tracker workspace with:

```bash
/workspace/extra/health-os/scripts/init-workspace.sh
```

7. Set initial working weights before the first `/next`:

```bash
/workspace/extra/health-os/scripts/set-working-weight.sh --exercise squat --weight 80
/workspace/extra/health-os/scripts/set-working-weight.sh --exercise bench_press --weight 60
```

## Command Surface

The health chat should expose:

- `/today`
- `/next`
- `/why`
- `/weekly`
- `/log`

Those commands map directly to `health-os` scripts and should not be reimplemented inside NanoClaw.

## Daily Automation

Recommended schedule:

1. host-side Oura sync runs early morning
2. it calls `scripts/oura-sync-from-token.sh`
3. it ingests the normalized payload into the group workspace
4. NanoClaw then runs `/today` or the daily brief prompt

Use the scheduled task template in:

```text
templates/nanoclaw/telegram_health-tracker/oura-daily-sync.sh
```

## Boundary

- Telegram token stays in the NanoClaw runtime secret store.
- Oura credentials stay in a separate host-side secret path.
- `.health-os/` only stores tracker state, logs, and generated artifacts.

For the concrete env file and step-by-step runbook, see [runtime-setup.md](/Users/bknst/Projects/health-os/docs/runtime-setup.md).
