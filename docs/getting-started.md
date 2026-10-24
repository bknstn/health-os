# Getting started

Health OS keeps personal health context in a private workspace, separate from the reusable source code. Use it directly from a terminal or through any agent that can invoke the CLI. Training and recovery are the first implemented decision workflow.

## Current scope

You can maintain a personal profile, import documents, record subjective HealthEvents, ingest wearable observations, and query a shared timeline. The training engine logs sets, weights, reps, effort, and soreness; follows a configurable alternating A/B plan; selects `FULL`, `BASE`, or `LIGHT` sessions with scoring reasons; and generates daily and weekly reports.

Training recommendations use configurable heuristics and have not been clinically validated. Review the example plan and rules for your own use. Health OS does not diagnose conditions or prescribe treatment. It is an early-stage, local, single-user toolkit.

## Initialize a workspace

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

The first workout is Day A. Without recovery data for the selected day, legacy `next` and `today` use `BASE` mode and explain that recovery data is missing. `prepare-training` instead marks its card as scheduled-only with mode `UNAVAILABLE` and reports the gaps. Exercises without a starting weight are marked `unset` or `set manually`.

For direct Node.js calls, pass the workspace explicitly:

```bash
node src/cli.js next --workspace "$HEALTH_OS_WORKSPACE"
```

The shell wrappers also accept `--workspace PATH` and read `HEALTH_OS_WORKSPACE`. Direct Node.js calls use `--workspace PATH` or the current directory. Run examples from the repository root.

## Complete the training and recovery loop

Start with your profile, a personalized plan, and any available recovery data or subjective observations. Use `prepare-training` to gather the context for a selected date, record the completed workout, and review the weekly evidence. An external agent supplies interpretation and maintains derived health notes; the CLI does not call a model or synthesize conclusions.

See [agent integration](agent-integration-runbook.md#healthevents-and-timeline) for capturing subjective events and querying the timeline, and [memory maintenance](memory.md#external-agent-loop) for the evidence-to-notes step.

### Log a workout

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

### Try recovery decisions offline

The [example fixtures](../examples/README.md) contain invented metrics. Use a separate demo workspace to avoid mixing them with your own records:

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

### Connect Oura

Follow the [Oura setup guide](oura-oauth.md) to register an OAuth application, authorize access, and save a token file outside the workspace. Then sync a day:

```bash
# OURA_CLIENT_ID and OURA_CLIENT_SECRET must already be set in your environment.
export OURA_TOKEN_FILE="$HOME/.config/health-os/oura-token.json"
./src/scripts/sync-daily-source.sh --source oura --date YYYY-MM-DD
./src/scripts/today.sh --date YYYY-MM-DD
```

Replace `YYYY-MM-DD` with the same target date in both commands. Oura sync calls the provider API and updates the local workspace; it refreshes stored OAuth tokens when a refresh token is present. Credentials are only needed for this integration. List implemented connectors with `node src/cli.js connectors --workspace PATH`.

## Your data and configuration

All workspace state is stored under `<workspace>/.health-os/`:

```text
.health-os/
  manifest.json     workspace schema and selected profile path
  config/           plan, preparation policy, scoring rules, and working weights (JSON)
  data/             workout/recovery CSVs, wearable observation JSON, and HealthEvent SQLite
  artifacts/        generated daily and weekly reports (Markdown)
  memory/           derived evidence and agent-maintained pages (Markdown)
  personal/raw/     original documents
  personal/files/   processed notes and extracted text
```

Edit the copies in your workspace's `config/` to customize the program. The repository's `config/` contains defaults; initialization preserves existing workspace configuration.

`prepare-training` requires an initialized workspace and an explicit `--as-of` date or RFC3339 timestamp. It uses `.health-os/config/preparation-policy.json` for weekday assignments, allowed substitutions, recovery freshness and baseline coverage, and configured subjective-event adjustments. A date cutoff includes the full UTC day; a timestamp cutoff filters at that exact instant and excludes same-day day-only or cutoff-crossing interval inputs. Fresh scored observations with adequate same-source baselines can support a decision; scoreless physical observations cannot. If recovery is unavailable, the result marks its workout card as scheduled-only with mode `UNAVAILABLE` and explains the gaps. Missing profiles are reported as a gap; missing or invalid required configuration is a command error. Preparation does not write domain data, seed missing files, or mutate memory-review state; workspace locking and SQLite reads may create or update auxiliary WAL/SHM files. The command does not change the legacy `next` or `today` behavior.

The workspace contains sensitive health data and is stored as ordinary, unencrypted files. Keep it private, restrict access, and back it up securely. The repository ignores `.health-os/`, environment files, and common credential files, but ignore rules do not protect files already committed. Keep OAuth credentials and token files outside both the checkout and the workspace. Token exchange and refresh require a token-file destination unless `--export-token true` explicitly requests token contents; their routine output contains only storage metadata. Treat explicit token export as secret. See [security and privacy guidance](../SECURITY.md).

For profile metadata, migrations, storage ownership, and the full workspace layout, see [framework and workspace boundaries](framework-and-workspace.md). For all command groups and output behavior, see the [CLI reference](cli-reference.md).
