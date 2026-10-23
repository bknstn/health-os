# File-native LLM memory

Health OS keeps private, runtime-only memory under `.health-os/memory/`. The directory is already covered by the repository's `.health-os/` ignore rule and must not be committed. It belongs to the selected Health OS workspace, alongside the data it describes.

The memory commands run locally without model API calls. The design rationale and LLM Wiki attribution are recorded in [ADR 0006](adr/0006-file-native-memory.md).

## Data model

```text
.health-os/
  data/                    authoritative structured records
  artifacts/weekly.md     reproducible weekly output
  memory/
    SCHEMA.md              maintenance and epistemic rules
    index.md               deterministic page index
    log.md                 idempotent evidence compilation log
    evidence/              deterministic weekly evidence bundles
    wiki/                  LLM-maintained derived pages
```

Structured data, original personal files, configuration, and reproducible artifacts remain the sources of truth. Memory pages are derived context. `SCHEMA.md` defines required page metadata, allowed epistemic statuses, provenance rules, and the human confirmation gate for `accepted_rule`.

Subjective HealthEvents live in the private, schema-versioned SQLite store at `data/events.sqlite`; existing workout and recovery CSVs remain authoritative for those records. Each successful event mutation advances a generation and marks derived memory pending in `memory/event-review.json`. Until the current generation is explicitly reviewed, `memory-context` fails closed, including when a completed request with the same idempotency key exists. `memory-lint` reports the pending gate. After updating affected wiki/evidence pages, run `context-revalidate-memory --generation N` with the exact generation reported by the CLI. Revalidation checks the marker against every current SQLite event row and rejects unknown, deleted, superseded, or stale-revision references in both `memory/wiki/` and `memory/evidence/`.

Use `health-event:<lowercase-uuid>@<revision>` in Markdown when a claim depends on a stored event. Keep the reference current after correction. Removing a deleted event's stale reference is required before revalidation. The gate is workspace-wide, so one event change blocks all derived-memory retrieval until review completes. Health OS never edits these Markdown pages. Event deletion scrubs the current live payload and revision digests, but older memory-context results may remain in `.health-os/operations/`, and SQLite WALs and independent backups have their own retention. The CLI blocks stale result replay; expire stored operations/backups separately if deletion must cover retained copies. See [the workspace guide](framework-and-workspace.md#healthevents-and-the-unified-timeline).

A personal card and long-form processed health documents can remain Markdown under `personal/files/`, managed by the external agent. They are a separate layer from derived wiki pages. The current memory retrieval command does not automatically load those documents or a profile; the agent must select and read relevant files separately. See [framework and workspace boundaries](framework-and-workspace.md) for the storage and ownership model.

## Commands

Compile the seven-day window ending on an explicit date:

```bash
./src/scripts/memory-update.sh --end-date 2026-07-19
```

This refreshes `artifacts/weekly.md`, writes `memory/evidence/weekly-2026-07-19.md`, rebuilds `index.md`, and appends one stable log entry. Repeating it with unchanged inputs is idempotent. It creates an evidence seed only; it does not ask an LLM to form conclusions.

Retrieve bounded lexical context for an external agent:

```bash
./src/scripts/memory-context.sh \
  --query "squat progression and recovery" \
  --max-pages 5 \
  --max-chars 12000
```

The command searches `wiki/` and `evidence/` using ordinary terms, returns the index plus the highest-scoring Markdown pages, and never calls the network. It does not search `personal/files/` or provide semantic/vector retrieval.

Validate maintained memory:

```bash
./src/scripts/memory-lint.sh --date 2026-07-19 --stale-days 90
```

Output is JSON. Missing metadata or provenance, invalid epistemic status, an unconfirmed accepted rule, or a broken Markdown link is an error and produces a nonzero exit. Stale review dates are warnings and do not fail the command.

## External agent loop

1. Run `memory-update` after the weekly summary inputs are current.
2. Run `memory-context` for the user's question.
3. If useful, maintain narrowly scoped Markdown pages under `wiki/`, following `SCHEMA.md` exactly.
4. Leave hypotheses as hypotheses. Do not promote a page to `accepted_rule` without explicit confirmation from the human owner.
5. Run `memory-lint` and stop on errors.

The CLI is the stable integration boundary. External agents should not edit `.health-os/data/` or infer medical conclusions from personal correlations.
