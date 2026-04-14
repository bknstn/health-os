# Health OS

Private repo for the NanoClaw-based health tracker.

## What Lives Here

- the training engine
- default program and readiness rules
- command-line tools for logging and analysis
- NanoClaw integration templates

## Runtime Model

This repo is mounted into a dedicated NanoClaw group as read-only code.

Mutable state is created in the group workspace under `.health-os/`.

## Commands

Initialize a workspace:

```bash
./scripts/init-workspace.sh
```

Log a workout from stdin:

```bash
cat workout.txt | ./scripts/log-workout.sh
```

Show the next workout:

```bash
./scripts/next-workout.sh
```

Generate today's brief:

```bash
./scripts/today.sh
```

Ingest normalized recovery data:

```bash
cat daily-state.json | ./scripts/ingest-daily-state.sh
```

Validate a normalized recovery payload:

```bash
cat daily-state.json | ./scripts/validate-daily-state.sh
```

Generate a weekly summary:

```bash
./scripts/weekly-summary.sh
```

Run tests:

```bash
npm test
```
