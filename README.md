# Health OS

Health OS is a local command-line toolkit for tracking strength training and using recovery data to plan the next session. It turns structured workout logs and daily readiness metrics into an explainable workout card, a daily brief, and a weekly summary.

Use it directly from a terminal or as a tool for an external AI agent. Your records stay in a workspace you control. Oura is the current built-in wearable connector; explicit forks can add providers using the versioned observation contract. Existing normalized recovery JSON remains supported without a wearable account.

Health OS is intended as a reusable, extensible, CLI-first foundation: clone or fork the source, keep your personal data in a separate private workspace, and adapt it to your needs. The repository supplies code, generic defaults, schemas, and invented examples. An external agent can maintain private Markdown documents and the health wiki while using the CLI for structured records. See [framework and workspace boundaries](docs/framework-and-workspace.md).

## What you can do

- Log exercises, sets, weights, reps, effort, and soreness in a structured text format.
- Follow an alternating A/B training plan with configurable starting weights and progression rules.
- Get a `FULL`, `BASE`, or `LIGHT` session recommendation with the scoring reasons.
- Prepare an as-of session card from the private profile, workspace policy, eligible workout/recovery history, subjective events, and reviewed health memory.
- Sync Oura or ingest provider-neutral physical wearable observations; legacy normalized recovery remains supported.
- Generate daily and weekly Markdown reports.
- Keep original health documents and processed notes in separate private folders.
- Record and correct bounded subjective HealthEvents, then query them alongside authoritative legacy workout and recovery records.
- Compile weekly evidence and retrieve bounded Markdown context for an external agent.

The project is an early-stage, single-user toolkit. Training recommendations follow configurable heuristics; they have not been clinically validated. Review the example plan and rules for your own use. Health OS does not diagnose conditions or prescribe treatment.

## Quick start

Requires **Node.js 22.13.0 or newer**, Git, and a POSIX shell for the shell wrappers. SQLite events use Node's built-in `node:sqlite` module; there are no third-party runtime dependencies, database services, or model API keys to configure.

```bash
git clone https://github.com/bknstn/health-os.git
cd health-os

# Keep your private workspace outside the source checkout.
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
./src/scripts/init-workspace.sh

# Personalize the private Markdown profile before using agent-facing context.
node src/cli.js profile-show --workspace "$HEALTH_OS_WORKSPACE"
# Edit .health-os/personal/files/profile.md, then validate the metadata.
node src/cli.js profile-validate --workspace "$HEALTH_OS_WORKSPACE"

# Set example starting weights in kilograms; choose your own values.
./src/scripts/set-working-weight.sh --exercise squat --weight 40
./src/scripts/set-working-weight.sh --exercise bench_press --weight 30

# Inspect the next session and today's brief. No Oura account is needed.
./src/scripts/next-workout.sh
./src/scripts/today.sh

# Prepare a bounded, read-only context for a terminal or generic agent caller.
node src/cli.js prepare-training --as-of "$(date -u +%F)" \
  --workspace "$HEALTH_OS_WORKSPACE" --json
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

The canonical entrypoint is `node src/cli.js <command> --workspace PATH`. Existing operations have shell wrappers in `src/scripts/`; workspace inspection, migration, and profile commands use the CLI entrypoint.

| Command | Purpose |
| --- | --- |
| `init-workspace` | Create `.health-os/manifest.json`, a neutral profile card, and missing defaults |
| `workspace-inspect` | Inspect workspace schema and selected profile without writes |
| `workspace-migrate` | Deliberately add the workspace schema; supports `--dry-run` |
| `profile-show` | Return a bounded view of the selected Markdown profile |
| `profile-validate` | Validate selected profile metadata and document size |
| `prepare-training` | Return a bounded as-of training context without changing workspace domain data |
| `version` / `capabilities` | Report CLI and machine-contract versions and supported command subsets |
| `set-working-weight` | Set an exercise's initial working weight |
| `log-workout` | Store a workout from stdin or `--input FILE` |
| `next` | Print the next workout card |
| `today` | Print a daily brief and write `artifacts/today.md` |
| `why` | Explain the latest stored recovery decision |
| `weekly-summary` | Print a seven-day summary and write `artifacts/weekly.md` |
| `validate-daily-state` | Validate normalized recovery JSON |
| `ingest-daily-state` | Validate, score, and store daily recovery JSON |
| `connectors` / `sync-daily-source` | List connectors or fetch and ingest a provider day |
| `validate-wearable-observations` | Validate a HealthObservationSet v1 without workspace writes |
| `ingest-wearable-observations` / `wearable-observations` | Store idempotent observations or read bounded source/date sets |
| `personal-raw-dir` / `personal-files-dir` | Print original-document or processed-note directories |
| `import-personal-file` | Copy a document into the workspace with `--file FILE` |
| `memory-update` | Compile a weekly evidence bundle with `--end-date YYYY-MM-DD` |
| `memory-context` | Retrieve relevant local Markdown with `--query TEXT` |
| `memory-lint` | Check memory metadata, provenance, and links |

Human-readable output remains the default. Add `--json` to any command for one compact, versioned envelope on stdout; command failures use the same envelope and still exit nonzero. Human-mode failures go to stderr. `version` and `capabilities --json` expose the CLI and envelope schema versions, command-specific stdin, idempotency, token, and write-lock capabilities. The JSON envelope and returned context are bounded; inspect its `truncation` field when present.

Use `--input-json` with `log-workout`, `ingest-daily-state`, or `validate-daily-state` to read a bare validated JSON payload object from stdin. Command options remain command-line flags; do not wrap payloads in a command/options object. Existing `--input FILE|-` behavior and shell wrappers remain available. The `--idempotency-key KEY` option is supported only by the workspace commands listed by `capabilities`; a replay returns its original result, a key reused for different input fails with a conflict, and an interrupted pending request fails closed for inspection.

Workspace-writing CLI operations coordinate through a local lock and replace individual files atomically. This protects covered operations across Health OS processes, including init, migrations, reports, CSV/config updates, and memory writes. Token refresh uses a separate lock keyed by the canonical token-file path, so refreshes that share a token file serialize across workspaces. A killed process leaves a lock that requires manual inspection and removal; locks are never discarded by age. Multi-file CSV and raw-bundle writes are not transactions, so a crash between files can leave a partial operation. The local token lock cannot make provider-side token rotation plus local replacement a distributed transaction; if storage fails after a single-use refresh token rotates, reauthorization may be required. The CLI does not coordinate with external programs that edit workspace files directly.

Legacy read/result commands (`next`, `why`, `memory-context`, and `memory-lint`) may create missing workspace defaults while producing a result. Workspace-writing operations also initialize the files they need before applying the requested change. `workspace-inspect`, profile commands, `version`, `capabilities`, and validation commands do not initialize the workspace. `oura-fetch-day` reads the configured token under its file lock and only writes a data bundle when `--output-dir` is set.

## Your data and configuration

All workspace state is stored under `<workspace>/.health-os/`:

```text
.health-os/
  config/           plan, preparation policy, scoring rules, and working weights (JSON)
  data/             workout, recovery, and decision records (CSV)
  artifacts/        generated daily and weekly reports (Markdown)
  memory/           derived evidence and agent-maintained pages (Markdown)
  personal/raw/     original documents
  personal/files/   processed notes and extracted text
```

Edit the copies in your workspace's `config/` to customize the program. The repository's `config/` contains defaults; initialization preserves existing workspace configuration.

`prepare-training` requires an initialized workspace and an explicit `--as-of` date or RFC3339 timestamp. It uses `.health-os/config/preparation-policy.json` for weekday assignments, allowed substitutions, recovery freshness and baseline coverage, and configured subjective-event adjustments. A date cutoff includes the full UTC day; a timestamp cutoff filters at that exact instant and excludes same-day day-only or cutoff-crossing interval inputs. Fresh scored observations with adequate same-source baselines can support a decision; scoreless physical observations cannot. If recovery is unavailable, the result marks its workout card as scheduled-only with mode `UNAVAILABLE` and explains the gaps. Missing profiles are reported as a gap; missing or invalid required configuration is a command error. Preparation does not write domain data, seed missing files, or mutate memory-review state; workspace locking and SQLite reads may create or update auxiliary WAL/SHM files. The command does not change the legacy `next` or `today` behavior.

The workspace contains sensitive health data and is stored as ordinary, unencrypted files. Keep it private, restrict access, and back it up securely. The repository ignores `.health-os/`, environment files, and common credential files, but ignore rules do not protect files already committed. Keep OAuth credentials and token files outside both the checkout and the workspace. Token exchange and refresh require a token-file destination unless `--export-token true` explicitly requests token contents; their routine output contains only storage metadata. Treat explicit token export as secret. See [security and privacy guidance](SECURITY.md).

## Documentation

- [Reusable framework, private Markdown, and workspace boundaries](docs/framework-and-workspace.md)
- [External agent integration and training preparation](docs/agent-integration-runbook.md)
- [Oura OAuth and sync](docs/oura-oauth.md)
- [Recovery contract and connector development](docs/health-data-connectors.md)
- [Personal document import](docs/personal-files.md)
- [Memory commands and maintenance](docs/memory.md)
- [Workspace backup, restore, and export](docs/workspace-backup-restore.md)
- [Framework compatibility guide](docs/compatibility.md)
- [Architecture decision records](docs/adr/README.md)

## Development

Node.js 22.13.0 or newer is required. The CLI and examples use Node built-ins; no dependency installation is needed to run them. `npm ci` is optional for a conventional clean CI setup. This package is marked private and is not published to npm.

```bash
npm ci --ignore-scripts
npm test
```

Tests use local fixtures and mocked provider responses; they do not require Oura credentials. See [CONTRIBUTING.md](CONTRIBUTING.md) for changes and pre-publication checks.

## License

[MIT License](LICENSE).
