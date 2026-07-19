# Health OS Memory Instructions

This directory is derived, file-native memory for an external LLM agent. It is not a database and it is not the source of truth.

## Authority and safety

- `.health-os/data/`, configuration, original personal files, and reproducible Health OS artifacts remain authoritative.
- Markdown under `memory/` is derived and may be incomplete or wrong. Follow its provenance back to the source before making consequential decisions.
- Do not make medical diagnoses or turn correlations into medical claims.
- `memory-update` only creates deterministic evidence bundles. It does not perform LLM synthesis.
- An external agent may maintain pages under `wiki/`, but must preserve the metadata and evidence requirements below.

## Page metadata

Every Markdown file under `evidence/` or `wiki/` must start with YAML-style frontmatter containing:

```yaml
---
title: Example title
status: observation
confidence: medium
evidence_start: 2026-07-01
evidence_end: 2026-07-07
last_reviewed: 2026-07-07
provenance: ["../evidence/weekly-2026-07-07.md"]
human_confirmed: false
---
```

Allowed epistemic statuses:

- `observation`: a direct summary of cited personal evidence.
- `hypothesis`: a tentative interpretation that needs more evidence.
- `accepted_rule`: a personal operating rule. It requires `human_confirmed: true` and supporting provenance.
- `general_claim`: a non-personal factual claim. Its provenance must point to an appropriate external source or a locally preserved source note.

Required fields are `title`, `status`, `confidence`, `evidence_start`, `evidence_end`, `last_reviewed`, and `provenance`. Dates use `YYYY-MM-DD`. Confidence is `low`, `medium`, or `high`. `evidence_start` must not be after `evidence_end`.

`provenance` is a JSON array of source paths or URLs. A personal observation or hypothesis must cite the relevant evidence bundle or authoritative workspace source. An accepted rule must never be promoted automatically: only the human owner can confirm it, recorded as `human_confirmed: true`.

## Maintenance contract

1. Run `memory-update` to compile a weekly evidence bundle.
2. Use `memory-context --query ...` to retrieve bounded lexical context for synthesis.
3. Write or revise wiki pages with explicit epistemic status and provenance.
4. Run `memory-lint` before relying on or publishing revised memory.
5. Treat stale-page findings as review prompts, not proof that a claim is false.

No embeddings, vector database, model SDK, or network access are part of this contract.
