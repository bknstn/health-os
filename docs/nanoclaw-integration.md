# NanoClaw Integration

## Goal

Run the `health-os` tracker from a dedicated NanoClaw Telegram group without modifying the tracker code to live inside the NanoClaw repo.

## Runtime Contract

NanoClaw should provide:

- Telegram transport
- a dedicated group folder, for example `telegram_health-tracker`
- an additional read-only mount for this repo at `/workspace/extra/health-os`
- a secure credential path for future Oura sync

The health group should store all mutable data inside its own workspace:

```text
/workspace/group/.health-os/
```

## Recommended Group Setup

### 1. Telegram side

- apply Telegram support in the NanoClaw runtime
- register a dedicated solo chat or private group for health tracking
- set `requiresTrigger=false`

Exact registration command from the NanoClaw checkout:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "tg:<chat-jid>" \
  --name "Health Tracker" \
  --folder "telegram_health-tracker" \
  --trigger "@Andy" \
  --channel telegram \
  --no-trigger-required
```

### 2. Additional mount

Mount the private repo into the health group container:

- host path: the `health-os` checkout
- container path: `health-os`
- readonly: `true`

Inside the group container that becomes:

```text
/workspace/extra/health-os
```

NanoClaw does not expose `containerConfig` from `register_group`, so the mount is a second step.

Exact update command from the NanoClaw checkout:

```bash
HEALTH_OS_ROOT="/absolute/path/to/health-os" \
TG_CHAT_JID="tg:<chat-jid>" \
npx tsx --eval "
  import { initDatabase, getRegisteredGroup, setRegisteredGroup } from './src/db.ts';
  initDatabase();
  const jid = process.env.TG_CHAT_JID;
  const healthOsRoot = process.env.HEALTH_OS_ROOT;
  if (!jid || !healthOsRoot) throw new Error('Missing TG_CHAT_JID or HEALTH_OS_ROOT');
  const group = getRegisteredGroup(jid);
  if (!group) throw new Error('Registered group not found');
  setRegisteredGroup(jid, {
    ...group,
    containerConfig: {
      ...(group.containerConfig || {}),
      additionalMounts: [
        {
          hostPath: healthOsRoot,
          containerPath: 'health-os',
          readonly: true
        }
      ]
    }
  });
"
```

Helper script version:

```bash
NANOCLAW_ROOT="/absolute/path/to/nanoclaw" \
HEALTH_OS_ROOT="/absolute/path/to/health-os" \
TG_CHAT_JID="tg:<chat-jid>" \
./examples/nanoclaw/register-health-tracker.sh
```

If NanoClaw mount validation rejects the path, add the repo root to `~/.config/nanoclaw/mount-allowlist.json` first.

## Group Initialization

From the health group container shell:

```bash
/workspace/extra/health-os/scripts/init-workspace.sh
```

This creates:

```text
/workspace/group/.health-os/
```

with config, data, and artifact files.

## Command Mapping

The group `CLAUDE.md` should map user intents to these scripts:

- `/today` -> `/workspace/extra/health-os/scripts/today.sh`
- `/next` -> `/workspace/extra/health-os/scripts/next-workout.sh`
- `/why` -> `/workspace/extra/health-os/scripts/why.sh`
- `/weekly` -> `/workspace/extra/health-os/scripts/weekly-summary.sh`
- `/log` -> pipe the raw structured message body into `/workspace/extra/health-os/scripts/log-workout.sh`

Use the template at:

```text
templates/nanoclaw/telegram_health-tracker/CLAUDE.md
```

## Recovery Data Ingestion

The current engine expects a normalized daily payload.

Validate a payload:

```bash
cat examples/recovery/normalized-good-day.json | ./scripts/validate-daily-state.sh
```

Ingest a payload:

```bash
cat examples/recovery/normalized-good-day.json | ./scripts/ingest-daily-state.sh
```

This keeps the business logic stable while the actual Oura fetcher remains a separate concern.

### Contract

Required fields:

- `date`
- `readiness_score`
- `sleep_score`
- `hrv`
- `hrv_baseline_28d`
- `resting_hr`
- `resting_hr_baseline_28d`
- `source_sync_time`
- `raw_metrics.readiness_score`
- `raw_metrics.sleep_score`
- `raw_metrics.hrv`
- `raw_metrics.resting_hr`

Optional fields:

- `sleep_efficiency`
- `total_sleep_minutes`
- `temperature_deviation`
- matching optional fields inside `raw_metrics`

Example files:

- [normalized-good-day.json](/Users/bknst/Projects/health-os/examples/recovery/normalized-good-day.json)
- [normalized-bad-day.json](/Users/bknst/Projects/health-os/examples/recovery/normalized-bad-day.json)

### Scheduled task templates

Use the provided sample script for a host-side normalized payload drop:

```text
templates/nanoclaw/telegram_health-tracker/ingest-normalized-recovery.sh
```

It expects a payload file at:

```text
/workspace/group/incoming/daily-state.json
```

and returns NanoClaw-compatible JSON:

- `wakeAgent=false` when the payload was ingested successfully
- `wakeAgent=true` when the payload is invalid or ingestion fails

Daily brief prompt template:

```text
templates/nanoclaw/telegram_health-tracker/daily-brief.prompt.md
```

Weekly summary prompt template:

```text
templates/nanoclaw/telegram_health-tracker/weekly-summary.prompt.md
```

## Credential Rule

Do not store raw Oura credentials in `/workspace/group/`.

Use the runtime secret manager or a host-side adapter, then hand the engine only normalized data or an injected request path.
