# Health OS

Health OS is a local command-line toolkit for tracking strength training and using recovery data to plan the next session. It turns structured workout logs and daily readiness metrics into an explainable workout card, a daily brief, and a weekly summary.

Use it directly from a terminal or as a tool for an external AI agent. Your records stay in a workspace you control. Oura is the currently implemented wearable connector; you can also import normalized recovery JSON without a wearable account.

## What you can do

- Log exercises, sets, weights, reps, effort, and soreness in a structured text format.
- Follow an alternating A/B training plan with configurable starting weights and progression rules.
- Get a `FULL`, `BASE`, or `LIGHT` session recommendation with the scoring reasons.
- Sync Oura readiness, sleep, heart rate variability (HRV), and resting heart rate, or ingest a compatible daily payload.
- Generate daily and weekly Markdown reports.
- Keep original health documents and processed notes in separate private folders.
- Compile weekly evidence and retrieve bounded Markdown context for an external agent.

The project is an early-stage, single-user toolkit. Training recommendations follow configurable heuristics; they have not been clinically validated. Review the example plan and rules for your own use. Health OS does not diagnose conditions or prescribe treatment.

## Quick start

Requires **Node.js 22 or newer**, Git, and a POSIX shell for the shell wrappers. There are no third-party runtime dependencies, database services, or model API keys to configure.

```bash
git clone https://github.com/bknstn/health-os.git
cd health-os

# Keep your private workspace outside the source checkout.
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
./src/scripts/init-workspace.sh

# Set example starting weights in kilograms; choose your own values.
./src/scripts/set-working-weight.sh --exercise squat --weight 40
./src/scripts/set-working-weight.sh --exercise bench_press --weight 30

# Inspect the next session and today's brief. No Oura account is needed.
./src/scripts/next-workout.sh
./src/scripts/today.sh
```

The first workout is Day A. Without recovery data for the selected day, the engine uses `BASE` mode and the daily brief explains that recovery data is missing. Exercises without a starting weight are marked `unset` or `set manually`.

For direct Node.js calls, pass the workspace explicitly:

```bash
node src/cli.js next --workspace "$HEALTH_OS_WORKSPACE"
```

The shell wrappers also accept `--workspace PATH` and read `HEALTH_OS_WORKSPACE`. Direct Node.js calls use `--workspace PATH` or the current directory. Run examples from the repository root.

## Log a workout

Send a structured log on stdin. This is an invented example, not a recommended load or a complete session:

```bash
./src/scripts/log-workout.sh <<'EOF'
/log
day=A
actual_mode=BASE
duration_minutes=45
session_rpe=7
energy_pre=4
soreness_pre=2
squat=40x5,40x5,40x5,40x5
bench_press=30x5,30x5,30x5,30x5
notes=Example session
EOF

./src/scripts/next-workout.sh
./src/scripts/weekly-summary.sh
```

Logs must start with `/log` and include all six session fields shown above and at least one exercise. Use exercise keys from your workspace's `config/training-plan.json`. Sets use `weightxreps`, separated by commas; bodyweight sets use `bwx8`. `session_rpe` records perceived effort. `notes` is optional. Pass `--date YYYY-MM-DD` to record a past session; otherwise the command uses the host's local date. After a completed Day A, the next card is Day B.

## Try recovery decisions offline

The [example fixtures](examples/README.md) contain invented metrics. Use a separate demo workspace to avoid mixing them with your own records:

```bash
node src/cli.js ingest-daily-state \
  --workspace "$HOME/.local/share/health-os/demo" \
  --input examples/recovery/normalized-good-day.json

node src/cli.js today \
  --workspace "$HOME/.local/share/health-os/demo" \
  --date 2026-04-13

node src/cli.js why --workspace "$HOME/.local/share/health-os/demo"
```

The good-day fixture produces `FULL` mode. `why` explains the latest stored decision. To inspect another payload before storing it, use `node src/cli.js validate-daily-state --workspace PATH --input FILE`.

## Connect Oura

Follow the [Oura setup guide](docs/oura-oauth.md) to register an OAuth application, authorize access, and save a token file outside the workspace. Then sync a day:

```bash
# OURA_CLIENT_ID and OURA_CLIENT_SECRET must already be set in your environment.
export OURA_TOKEN_FILE="$HOME/.config/health-os/oura-token.json"
./src/scripts/sync-daily-source.sh --source oura --date YYYY-MM-DD
./src/scripts/today.sh --date YYYY-MM-DD
```

Replace `YYYY-MM-DD` with the same target date in both commands. Oura sync calls the provider API and updates the local workspace; it refreshes stored OAuth tokens when a refresh token is present. Credentials are only needed for this integration. List implemented connectors with `node src/cli.js connectors --workspace PATH`.

## Commands

The canonical entrypoint is `node src/cli.js <command> --workspace PATH`. Shell wrappers in `src/scripts/` expose the same operations; `next-workout.sh` maps to `next`.

| Command | Purpose |
| --- | --- |
| `init-workspace` | Create private state and copy default configuration if missing |
| `set-working-weight` | Set an exercise's initial working weight |
| `log-workout` | Store a workout from stdin or `--input FILE` |
| `next` | Print the next workout card |
| `today` | Print a daily brief and write `artifacts/today.md` |
| `why` | Explain the latest stored recovery decision |
| `weekly-summary` | Print a seven-day summary and write `artifacts/weekly.md` |
| `validate-daily-state` | Validate normalized recovery JSON |
| `ingest-daily-state` | Validate, score, and store daily recovery JSON |
| `connectors` / `sync-daily-source` | List connectors or fetch and ingest a provider day |
| `personal-raw-dir` / `personal-files-dir` | Print original-document or processed-note directories |
| `import-personal-file` | Copy a document into the workspace with `--file FILE` |
| `memory-update` | Compile a weekly evidence bundle with `--end-date YYYY-MM-DD` |
| `memory-context` | Retrieve relevant local Markdown with `--query TEXT` |
| `memory-lint` | Check memory metadata, provenance, and links |

Briefs and workout cards are text. `ingest-daily-state` prints `mode=...` and `score=...`; validation, sync, and memory validation return JSON. A nonzero exit status indicates failure. Commands may initialize workspace directories; `today`, `weekly-summary`, and `memory-update` also write derived artifacts. Serialize operations that write to the same workspace.

## Your data and configuration

All workspace state is stored under `<workspace>/.health-os/`:

```text
.health-os/
  config/           training plan, scoring rules, and working weights (JSON)
  data/             workout, recovery, and decision records (CSV)
  artifacts/        generated daily and weekly reports (Markdown)
  memory/           derived evidence and agent-maintained pages (Markdown)
  personal/raw/     original documents
  personal/files/   processed notes and extracted text
```

Edit the copies in your workspace's `config/` to customize the program. The repository's `config/` contains defaults; initialization preserves existing workspace configuration.

The workspace contains sensitive health data and is stored as ordinary, unencrypted files. Keep it private, restrict access, and back it up securely. The repository ignores `.health-os/`, environment files, and common credential files, but ignore rules do not protect files already committed. Keep OAuth credentials and token files outside both the checkout and the workspace. Token exchange and refresh commands print token JSON; treat their stdout as secret. See [security and privacy guidance](SECURITY.md).

## Documentation

- [Oura OAuth and sync](docs/oura-oauth.md)
- [Recovery contract and connector development](docs/health-data-connectors.md)
- [Personal document import](docs/personal-files.md)
- [Memory commands and maintenance](docs/memory.md)
- [External agent integration](docs/agent-integration-runbook.md)
- [Architecture decisions and project evolution](docs/adr/README.md)

## Development

```bash
npm ci --ignore-scripts
npm test
```

Tests use local fixtures and mocked provider responses; they do not require Oura credentials. See [CONTRIBUTING.md](CONTRIBUTING.md) for changes and pre-publication checks.

## License

[Apache License 2.0](LICENSE).
