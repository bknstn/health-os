# Health OS — Private Repo Plan

## Summary

`health-os` is the private source repo for the health tracker.

NanoClaw is an external runtime:

- it owns Telegram transport
- it owns group isolation and scheduling
- it does not own the health business logic

The health tracker itself lives in this repo as a mounted toolset that NanoClaw can call from a dedicated Telegram health group.

## Boundaries

### This repo owns

- training plan defaults
- readiness rules
- structured workout logging
- daily state scoring
- weekly summaries
- reusable CLI and shell entrypoints
- NanoClaw integration templates and docs

### NanoClaw owns

- Telegram channel integration
- group registration
- additional mount configuration
- scheduled task execution
- secret injection / credential management

### Mutable state location

Tracker state should live in the NanoClaw group folder, not in the repo checkout.

Expected runtime layout inside the group:

```text
/workspace/group/.health-os/
  config/
    training-plan.json
    rules.json
  data/
    workout_sessions.csv
    exercise_logs.csv
    recovery_snapshots.csv
    daily_state.csv
    decision_log.csv
    rules_history.csv
  artifacts/
    today.md
    weekly.md
```

The repo is mounted separately, read-only, for example at:

```text
/workspace/extra/health-os
```

## Architecture

### Repo shape

- `config/` stores default program and scoring rules
- `src/` stores the deterministic engine and CLI
- `scripts/` exposes stable shell entrypoints for NanoClaw
- `templates/` stores NanoClaw group templates
- `docs/` stores integration notes

### State model

The first usable version is file-based and human-auditable:

- CSV for canonical tabular logs
- JSON for config
- Markdown for generated artifacts

This avoids coupling the tracker to NanoClaw internals and avoids runtime patching just to get SQLite working.

### Oura integration boundary

The first engine contract uses a normalized daily payload as input.

That means:

- this repo computes daily mode from normalized recovery metrics
- NanoClaw or a host-side adapter can fetch Oura data and pass it in
- raw Oura credentials must not be stored in the group folder

The normalized payload shape is:

```json
{
  "date": "2026-04-13",
  "readiness_score": 82,
  "sleep_score": 78,
  "hrv": 47,
  "hrv_baseline_28d": 51,
  "resting_hr": 54,
  "resting_hr_baseline_28d": 52,
  "sleep_efficiency": 89,
  "total_sleep_minutes": 435,
  "temperature_deviation": 0.2,
  "source_sync_time": "2026-04-13T06:45:00+02:00",
  "raw_metrics": {
    "readiness_score": 82,
    "sleep_score": 78,
    "hrv": 47,
    "resting_hr": 54
  }
}
```

## User Commands

The NanoClaw health group stays command-first.

### `/today`

Shows:

- today recovery summary
- recommended mode
- next workout
- target weights
- explanation

### `/next`

Shows:

- next A or B session
- target sets, reps, and weights
- load adjustments for current mode

### `/log`

Uses strict multiline input:

```text
/log
day=A
actual_mode=BASE
duration_minutes=58
session_rpe=7
energy_pre=4
soreness_pre=2
squat=80x5,80x5,80x5,80x5
bench_press=60x5,60x5,60x5,60x5
romanian_deadlift=90x8,90x8,90x8
bulgarian_split_squat=18x8,18x8,18x8
core=3x1
notes=Felt solid, left reps in reserve on squat
```

### `/why`

Shows the latest decision inputs and score breakdown.

### `/weekly`

Shows:

- last 7 day training count
- recovery trends
- progression status
- fatigue or deload signal

## Training Rules

### Day A

- squat: `4x5`
- bench press: `4x5`
- Romanian deadlift: `3x6-8`
- Bulgarian split squat: `3x8`
- core: `3` sets

### Day B

- deadlift or trap bar deadlift: `3x5`
- pull-ups or lat pulldown: `4x6-10`
- standing barbell press: `3x5-6`
- barbell row: `3x6-8`
- kettlebell swing: `3x12-15`

### Progression

- clean session with room in reserve:
  - `+2.5 kg` upper body
  - `+2.5-5 kg` lower body
- too hard or technique breaks:
  - hold weight
- two failures in a row:
  - deload `5-10%`
- accessory movements progress by reps first

### Mode scoring

Initial scoring rules:

- readiness `>= 85`: `+2`
- readiness `75-84`: `+1`
- readiness `< 75`: `-2`
- sleep `>= 80`: `+2`
- sleep `70-79`: `+1`
- sleep `< 70`: `-2`
- HRV delta `>= -10%`: `+1`
- HRV delta `< -10%`: `-1`
- resting HR delta `<= 3 bpm`: `+1`
- resting HR delta `> 3 bpm`: `-1`
- previous session RPE `>= 9`: `-1`
- soreness `>= 4`: `-1`

Mode cutoffs:

- `FULL`: score `>= 4`
- `BASE`: score `1-3`
- `LIGHT`: score `<= 0`

## Implementation Phases

### Phase 1

Build the private repo baseline:

- config defaults
- CLI
- workspace init
- `/log`
- `/next`
- `/today`
- `/why`
- `/weekly`
- NanoClaw integration template

### Phase 2

Add normalized daily-state ingestion:

- append raw recovery snapshots
- compute deltas
- score recommended mode
- persist decision log

### Phase 3

Add live Oura adapter:

- verify Oura API contract
- map raw API responses into the normalized payload
- wire credential injection through the runtime, not the group folder

### Phase 4

Add self-tuning and deload heuristics after real usage data exists.

## Acceptance Criteria

The first integrated version is done when:

1. NanoClaw can mount this repo read-only into a dedicated Telegram health group.
2. `scripts/init-workspace.sh` creates a clean `.health-os/` state folder in the group workspace.
3. `/log` records a real workout in under 2 minutes.
4. `/next` computes a sensible next session from logged history.
5. `/today` produces a readable recommendation and writes `artifacts/today.md`.
6. `/weekly` produces a useful 7 day summary and writes `artifacts/weekly.md`.
7. Daily recovery ingestion updates `daily_state.csv` and `decision_log.csv`.
8. No raw Oura credential is stored in the group folder.
