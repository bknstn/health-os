# Health OS Plan

`health-os` is a CLI-first health discovery app.

The repo owns:

- deterministic training and recovery logic
- health workspace initialization
- workout logging
- daily and weekly artifacts
- normalized recovery ingestion
- Oura OAuth, fetch, normalize, and sync helpers
- optional systemd deployment templates

## Product Shape

The primary interface is the command line. Every meaningful workflow should be runnable through `src/cli.js` and mirrored by a stable shell wrapper in `scripts/`.

State lives in a user-controlled workspace:

```text
<workspace>/.health-os/
  config/
  data/
  artifacts/
```

Credentials do not belong in the workspace. Oura token JSON should live in an external config or server state path.

## Core Workflows

1. Initialize a workspace with `init-workspace`.
2. Set working weights with `set-working-weight`.
3. Log workouts with `log-workout`.
4. Ingest daily recovery state from normalized JSON or Oura.
5. Generate `today`, `why`, `next`, and `weekly-summary` outputs.
6. Optionally refresh those artifacts on a server schedule.

## Boundary

The app should remain useful without a chat runtime, web server, database service, or mobile client. Integrations can call the CLI, but they should not own the health logic.
