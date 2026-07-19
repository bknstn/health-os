# File-native LLM memory

Health OS keeps private, runtime-only memory under `.health-os/memory/`. The directory is already covered by the repository's `.health-os/` ignore rule and must not be committed. It belongs to the selected Health OS workspace, alongside the data it describes.

This is a small LLM Wiki-style contract, not RAG. There are no embeddings, vector database, model SDK, or network calls.

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

The command searches `wiki/` and `evidence/` using ordinary terms, returns the index plus the highest-scoring Markdown pages, and never calls the network.

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
