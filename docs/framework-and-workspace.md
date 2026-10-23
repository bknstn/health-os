# Reusable framework and private workspace

Health OS is a reusable, extensible, CLI-first toolkit for working with private health records. The source checkout contains the engine, CLI, schemas, and generic connector implementations; each operator chooses a separate private workspace. A human or external agent can use the same commands and machine-readable interface.

The framework separates source from private workspace state. It uses an explicit connector registry, versioned workspace and data contracts, bounded JSON responses, coordinated writes, and file-native narrative memory. HealthEvents and wearable observations complement existing CSV records, while as-of training preparation composes current profile, plan, history, recovery, subjective events, and reviewed memory evidence.

## Source is the scaffold

| Versioned source repository | Private workspace outside the checkout | External credentials |
| --- | --- | --- |
| Engine, CLI, connector implementations | Actual profile and personal health documents | Wearable client credentials and OAuth tokens |
| Schemas and generic starter configuration | Personalized training configuration and working weights | Agent/model credentials, if used by a caller |
| Invented examples and tests | Workouts, observations, events, generated reports | Messenger credentials, if used by a caller |
| Memory-maintenance rules and integration guides | Evidence bundles and agent-maintained health wiki | Stored separately from both source and health workspace |

Public source must contain no actual user's card, medical history, personal records, runtime memory, credentials, or delivery identifiers. Examples must be synthetic and starter templates must be generic. Forking the source must not copy another person's state.

Existing initialization copies starter configuration only when it is missing. Reinitializing preserves existing configuration, personal Markdown, and memory pages. Keep source updates and workspace/schema migrations separate: updating code must not replace private customizations with repository defaults.

## Choose storage by the work it needs to do

| Information | Storage direction | Ownership |
| --- | --- | --- |
| Personal card, goals, preferences, narrative history | Private Markdown, with minimal version/date/source metadata where needed | Agent-maintained from user statements and cited documents |
| Original uploads | Original private files in `personal/raw/` | Preserved evidence; agent creates separate processed notes |
| Processed documents and extracted text | Private Markdown/text in `personal/files/` | Agent/parser-maintained with provenance |
| Learned observations, hypotheses, personal rules | Existing `memory/wiki/*.md` and its metadata schema | Agent synthesis; accepted rules require explicit human confirmation |
| Reproducible weekly evidence | Existing `memory/evidence/*.md` | Deterministic Health OS generation |
| Workout and recovery records | Existing CSVs; retain compatibility | Validated CLI operations |
| Provider-neutral wearable observations | Versioned `.health-os/data/wearable-observations.json`; one current set per connector/date | Validated, explicitly registered connectors or bounded CLI ingestion |
| Queryable subjective events | Versioned SQLite EventStore in `.health-os/data/events.sqlite` | Validated CLI operations |
| Numeric settings used by calculations | Existing workspace JSON configuration | Validated commands or deliberate configuration updates |

Databases can store long text. The reason to prefer Markdown for the card and narrative memory is readability, portability, direct agent editing, and straightforward diffs/backups. SQLite is useful for typed events and indexed timeline queries; it need not become the mandatory home of every document.

`.health-os/manifest.json` records `schema_version: 1` and one explicit `profile_path`, relative to `.health-os/`. The default path is `personal/files/profile.md`; another Markdown filename can be selected during initialization or deliberate migration, but the path must remain under `personal/files/`. The CLI never searches for cards or chooses one by filename. It resolves symlinks and rejects profile paths whose target leaves the selected workspace's physical `personal/files/` directory.

The selected card is Markdown with strict frontmatter fields `schema_version: 1` and `updated: null` or a real `YYYY-MM-DD` date. `null` means the date is unknown. These are the only supported metadata fields; blank lines and `#` comments are allowed, and values must be plain unquoted scalars. Duplicate or unknown fields fail validation. `profile-validate` validates the complete document; `profile-show` returns the Markdown and parsed metadata with a default 12,000-character display limit (maximum 50,000). Validation reads at most 1 MiB. The Markdown remains authoritative; the parsed view is derived and rebuildable. Runtime-specific agent memory must not silently duplicate and override it.

The profile commands validate and expose the selected card; they do not edit its narrative text. Agents may maintain it with ordinary file tools or import processed Markdown through `import-personal-file --kind processed`. Existing cards with other names remain untouched unless selected explicitly.

Structured events capture dated occurrences; the card describes durable context. Do not turn a transient symptom into a permanent constraint or a hypothesis into an established user fact. Preserve sources, dates, uncertainty, and corrections in both layers.

## HealthEvents and the unified timeline

`context-add`, `context-query`, `context-correct`, `context-delete`, and `timeline` expose the event contract. The `events.sqlite` store is private and schema-versioned independently of the workspace manifest. The selected profile identity is its manifest-relative `profile_path`, so it remains stable if the checkout or workspace is moved. Event records are not copied into the workout or recovery CSVs.

A HealthEvent v1 is a JSON object with `schema_version`, optional `event_id`, `event_type`, `occurred`, `data`, `source`, `extraction_version`, `epistemic_status`, and `uncertainty`. `event_id` may be omitted on add, in which case Health OS generates one. Event IDs are UUIDs normalized to lowercase. `occurred` requires the keys `start`, `end`, `precision` (`instant`, `second`, `minute`, `hour`, `day`, `interval`, or `unknown`), and `timezone`; null bounds and timezone are explicit values where appropriate. The `timezone` field is an IANA zone, `Z`, an explicit offset from `-14:00` through `+14:00`, or `null`. Calendar-day precision remains a date label; unknown time keeps null bounds and can retain a known timezone. RFC3339 offsets are preserved rather than converted in stored records; a named timezone is retained independently and is not cross-validated against the timestamp offset. Timestamp fractions are supported to millisecond precision in schema v1 so SQLite and in-process ordering agree. Intervals require compatible date or timestamp bounds in chronological order. Health OS does not infer a daylight-saving conversion or manufacture an exact time from a day-only value. SQLite adds `ingested_at` and `updated_at` metadata.

`data` accepts finite JSON values within 16 KiB; the complete stdin event object is limited to 64 KiB. `source` records `kind`, `ref`, and `fragment_id` (default `0`). The profile, source, and fragment identify one capture. A replay with the same capture and content returns the existing event; reuse of that capture with different content is a conflict. One message that yields multiple events must assign a distinct stable fragment ID to each event. `extraction_version`, uncertainty level/note, and `epistemic_status` (`fact` or `pending`) preserve how strongly the observation is supported. The CLI does not invoke an LLM.

`context-add` and `context-correct` require `--idempotency-key` and bare HealthEvent JSON on stdin with `--input-json`. `context-delete` requires an idempotency key and flags only. Corrections preserve event ID and source identity and require `--expected-revision`; stale concurrent corrections fail with a revision conflict. `context-add --supersedes-event-id ID --expected-revision N` creates the replacement and marks the old event superseded in one SQLite transaction. Replaying an add for a superseded capture follows the current replacement; after that replacement is deleted, it returns only its tombstone. It cannot recreate the former fact. Delete also requires the current expected revision. Capture identities and idempotency digests remain as non-content tombstones to prevent accidental re-ingestion.

Deleting an event removes its active payload and revision digests from the live SQLite database. The EventStore request journal stores hashes and event IDs, not event bodies; supersession replay resolves to the latest replacement or a tombstone. This is logical deletion, not guaranteed forensic erasure: the separate `.health-os/operations/` journal may retain earlier `memory-context` result text, while SQLite WAL pages, filesystem snapshots, and backups may also contain earlier bytes. Generation checks prevent stale CLI replay from exposing cached memory results after an event change, but do not erase those stored bytes. Review and expire operation records, WAL files, and backups separately when deletion must cover retained copies.

Each successful event mutation advances the EventStore generation and writes a small `memory/event-review.json` marker before commit. `memory-context` fails closed while review is pending, including before any cached idempotent result can replay. Review wiki and evidence pages, update `health-event:<uuid>@<revision>` provenance references, then run `context-revalidate-memory --generation N` using the exact current generation. Revalidation checks every event row against the marker and scans Markdown in both `memory/wiki/` and `memory/evidence/`; unknown, deleted, superseded, or stale-revision references block it. `memory-lint` reports pending or stale event provenance. This is a conservative workspace-wide gate: any event change temporarily blocks retrieval until the derived pages are reviewed, even if a page does not discuss that event. Agents continue to own and edit their Markdown; Health OS never rewrites wiki content.

`context-query` accepts inclusive `--since`/`--through`, comma-separated `--type`/`--source`, `--limit` (1–50), and an optional `--event-id`. An exact ID lookup automatically includes inactive rows and tombstones; list queries include inactive rows with `--include-inactive true`. Queries return newest known timestamps first; unknown-time events sort after dated events. `timeline` composes filtered active events with the authoritative workout-session/exercise-log and daily-state/recovery-snapshot CSV files in ascending chronology. It does not migrate or mirror legacy rows. Date filters are inclusive UTC calendar dates, intervals match by overlap, and timestamp filters use the represented offset-aware chronology. Day-only and unknown timestamps retain their precision and receive deterministic tie ordering only; unknown-time records do not match a date filter. Blank CSV metrics remain unknown (`null`); malformed or date-less legacy rows are omitted and counted rather than coerced into valid events. `context-query` and `timeline` on a missing event store are read-only and do not scaffold a workspace. Query output is bounded to 50 records and reports truncation and omitted legacy row counts.

The SQLite store uses Node's built-in `node:sqlite`, available without an experimental startup flag from Node.js 22.13.0. Event commands load it lazily so version discovery and existing commands keep their prior startup behavior. Node may emit its `ExperimentalWarning` on stderr when an event command first loads the module; JSON command results remain on stdout. The database is created owner-only. Workspace locking serializes event commands with other participating writers; direct external file edits do not participate. If a crash or failed SQLite write leaves the review marker one generation ahead, the next write or `context-revalidate-memory --generation N` reconstructs that marker from current database rows; malformed or more divergent state fails closed for operator investigation. The event protocol coordinates one SQLite transaction, but it does not make legacy multi-file CSV updates transactional.

## As-of training preparation

`prepare-training --as-of YYYY-MM-DD|RFC3339` returns a bounded context combining the selected current profile snapshot, workspace session plan and settings, eligible workout history, recovery inputs, recent subjective HealthEvents, relevant memory pages, provenance paths, and explicit gaps. It uses one data contract from a terminal or a generic subprocess agent. It does not call a model, connector, messenger, or scheduler, and does not write domain data, seed missing files, or mutate memory-review state. Workspace locking and SQLite reads may create or update auxiliary WAL/SHM files. Missing or invalid required plan, rules, exercise settings, or preparation policy is a command error; if a valid manifest selects a missing profile, the output instead reports a profile gap and continues without its Markdown.

Date-only cutoffs include the full UTC day. RFC3339 cutoffs are exact instants, and source timestamps are checked against that instant before bounded history limits are applied. Same-day day-only workout/event/recovery inputs are excluded or marked ambiguous at exact cutoffs, and subjective intervals crossing the cutoff are excluded. Dated profile and policy files are current snapshots; their historical contents are not reconstructed. The legacy `next` and `today` commands retain their prior behavior.

`.health-os/config/preparation-policy.json` configures weekday-to-plan assignments and alternating fallback, whether `--session` overrides are allowed, an allowlist and per-session limit for explicit `--substitute FROM=TO[,FROM=TO]`, recovery freshness and baseline coverage, and exact subjective event types, numeric ranges, and optional set adjustments. Only the latest recent active low-uncertainty `fact` for each configured subjective type is eligible to adjust the card. Repeated check-ins do not stack; a later in-range normal fact supersedes an earlier low fact. Pending, high/unknown-uncertainty, unconfigured, and out-of-range events remain signals or gaps rather than silently becoming adjustments.

Recovery can use either eligible legacy daily-state rows (only when policy explicitly permits their unscoped baseline) or a fresh scored observation set. An observation-set decision requires fresh HRV, resting heart rate, readiness and sleep scores plus configured minimum baseline days from the same source. Scoreless physical observations remain available as provenance but cannot create a recovery score. Stale data, future source timestamps, missing metrics, empty/zero-invalid baselines, ambiguous providers, and inadequate coverage produce an unavailable decision with gaps. In that case, `workout.scheduled_only` is true and `workout.mode` is `UNAVAILABLE`; it is a schedule candidate rather than a recovery-supported recommendation.

Memory retrieval ranks pages against the selected plan and exercises, caps the result at five pages and each excerpt at 1,000 characters, and respects the EventStore generation/provenance review gate. Pending or inconsistent review blocks all derived memory content and reports a gap; direct eligible HealthEvents remain separate. Pages with `status: accepted_rule` and `human_confirmed: false` are omitted. The result and common `--json` envelope are bounded, and callers should inspect `truncation` and `gaps` before using context.

## Existing LLM Wiki-style memory

The implementation is in [`src/memory.js`](../src/memory.js), documented in [memory.md](memory.md) and [ADR 0006](adr/0006-file-native-memory.md). It is usable now:

```text
<private-workspace>/.health-os/
  manifest.json           workspace schema version and selected profile path
  config/                 private copies of starter configuration
  data/                   authoritative structured records
                          wearable-observations.json keeps neutral device readings separate from legacy recovery CSVs
  personal/raw/           original documents
  personal/files/         processed Markdown and the selected profile card
  artifacts/              reproducible daily/weekly output
  memory/
    SCHEMA.md             metadata, provenance, and maintenance rules
    index.md              page index
    log.md                evidence compilation log
    evidence/             deterministic weekly bundles
    wiki/                 agent-maintained derived pages
```

- `memory-update` compiles a weekly evidence seed and rebuilds the index. It does not call an LLM or write synthesized conclusions.
- `memory-context` performs bounded lexical retrieval over `memory/wiki/` and `memory/evidence/`. It does not search `personal/files/`, automatically load a profile, or provide semantic/vector search.
- `memory-lint` checks required metadata, provenance targets, supported statuses, links, human confirmation of accepted rules, and stale review dates.

An external agent reads the relevant personal card and documents separately, asks the CLI for current records and evidence, synthesizes narrowly scoped wiki pages, and runs the linter. The agent supplies reasoning; Health OS supplies data access and memory-maintenance contracts. This does not require a particular model provider, runtime, or agent SDK.

## Current clone/fork workflow

After cloning either the upstream repository or your own fork, choose a workspace outside that checkout:

```bash
export HEALTH_OS_WORKSPACE="$HOME/.local/share/health-os/workspace"
node src/cli.js init-workspace --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js workspace-inspect --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js profile-show --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js connectors --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js today --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js memory-update --workspace "$HEALTH_OS_WORKSPACE" --end-date YYYY-MM-DD
node src/cli.js memory-context --workspace "$HEALTH_OS_WORKSPACE" --query "training and recovery"
node src/cli.js memory-lint --workspace "$HEALTH_OS_WORKSPACE"
```

Replace `YYYY-MM-DD` with the desired seven-day window end date. Before health data exists, reports and evidence will have little content; initialization creates a scaffold rather than another user's records. Configure a wearable only when needed. The existing CLI can also ingest invented or compatible normalized data without an Oura account.

Personalize the card at `$HEALTH_OS_WORKSPACE/.health-os/personal/files/profile.md`. Replace or remove its generic headings, add only information the owner wants to keep, and set `updated` to the date of the last card edit; leave it `null` when the date is unknown. Run `profile-validate` after editing. `profile-show` exposes a bounded Markdown view for an external agent.

An existing workspace without `.health-os/manifest.json` is unversioned. `workspace-inspect` reads its status without creating files. Do not run `init-workspace` to silently adopt it: review the dry-run, then run migration deliberately. For example, to select an existing card named `owner-card.md`:

```bash
node src/cli.js workspace-inspect --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js workspace-migrate --to 1 --dry-run \
  --profile personal/files/owner-card.md --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js workspace-migrate --to 1 \
  --profile personal/files/owner-card.md --workspace "$HEALTH_OS_WORKSPACE"
```

Migration validates an existing selected card before writing. If the selected path is missing in an unversioned workspace, it creates the generic template there; an existing invalid card fails without writes and needs its required frontmatter added manually. A missing profile in a versioned workspace is an error, and reinitialization will not recreate a deleted established card. Inspect and profile commands are read-only. Init and migration join the shared workspace lock and use atomic replacements. The CLI coordinates its own covered operations; external tools that directly modify workspace files must still avoid overlapping writes.

`node src/cli.js version` and `node src/cli.js capabilities --json` report the CLI version, envelope version, workspace schema versions, supported JSON stdin/idempotency commands, and write-lock subsets. Any command accepts opt-in `--json`; it emits one compact `schema_version: 1` envelope on stdout and keeps the existing success/failure exit status. JSON errors also go to stdout; human-mode errors use stderr. `--input-json` reads a bare recovery payload, normalized workout object, or HealthEvent object on stdin for the exact commands listed by `capabilities`. It does not accept command-option wrappers.

The response context is bounded (256 KiB serialized envelope, 12,000 characters per text field by default, 100 list entries, 100 object keys, and a bounded node/depth count). Profile display has its own `--max-chars` limit and reports its returned/total character counts; profile validation reads the complete selected card. A `truncation` field identifies any clipped JSON values.

Writes use a process lock keyed to the canonical physical `.health-os` path, stored beside that private directory, and atomic per-file sibling-temp replacements. A lock also canonicalizes `.health-os` symlink aliases. The Oura token path has a separate canonical-path lock spanning read, refresh, and replacement, including connector refreshes. If a process dies while holding a lock, the next writer fails closed; inspect that lock's owner metadata and remove it manually only after verifying the owner is gone. Locks have no age-based eviction. Per-file replacement does not turn legacy multi-CSV updates into transactions; a crash can interrupt an operation between CSV files. Direct edits by other programs do not participate in these locks.

Direct Node commands require `--workspace` to select this path; shell wrappers also honor `HEALTH_OS_WORKSPACE`. The fallback to the current directory exists for compatibility, so external agents should always pass the workspace explicitly. Legacy read/result commands `next`, `why`, `memory-context`, and `memory-lint` may seed missing files; workspace-writing operations also initialize the defaults they need. Inspection/profile/version/capability/validation reads do not initialize a workspace. Ignore rules protect the standard `.health-os/` path from ordinary accidental additions, but source/data separation is the primary convention.

## Extending the framework

- **Training and recovery policy:** customize private workspace configuration; existing starter settings are examples, not a universal program.
- **Wearable connectors:** implement the [connector contract](health-data-connectors.md) and register the module. Oura and the registry contract support HealthObservationSet v1; registration remains explicit and requires source changes, with no automatic plugin discovery.
- **Provider-neutral observations:** HealthObservationSet v1 separates physical metrics from optional proprietary scores and reports missingness, source timestamps, freshness assessment, units, and baseline coverage. Observation-only connectors do not create recovery decisions.
- **Profile and health memory:** extend public schemas/templates while leaving actual content private. Preserve existing user-authored Markdown during upgrades and migrations.
- **Other agents:** use the same CLI subprocess contract, explicit workspace, stdout/stderr and exit statuses. Keep messenger identity, model calls, scheduling, and agent credentials in the caller.

Use the [compatibility guide](compatibility.md) when integrating a caller or moving a workspace, and the [workspace backup and restore guide](workspace-backup-restore.md) before relocating private state. The executable synthetic connector and generic subprocess caller are linked from [Health Data Connectors](health-data-connectors.md) and the [agent runbook](agent-integration-runbook.md).
