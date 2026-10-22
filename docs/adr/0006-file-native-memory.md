# 0006: Derived Markdown memory for external agents

Date: 2026-07-19

Status: Accepted

## Context

External agents benefit from durable, bounded context across training and recovery records. Reconstructing that context on every question is repetitive, while adding embeddings or a model SDK would introduce additional operational and provider dependencies.

## Decision

Maintain private Markdown memory under `.health-os/memory/`, inspired by Andrej Karpathy's [LLM Wiki concept](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Use deterministic weekly evidence compilation, lexical context retrieval, and metadata/provenance linting through `memory-update`, `memory-context`, and `memory-lint`.

Authoritative records, original files, configuration, and reproducible reports remain the sources of truth. An external agent may maintain derived wiki pages following the workspace schema. Distinguish observations, hypotheses, accepted personal rules, and general claims; promoting a rule requires explicit human confirmation.

## Consequences

Memory remains readable and editable with ordinary file tools, without a vector database or model-provider dependency. `memory-update` creates evidence seeds and does not perform LLM synthesis or medical inference. Agent-maintained pages require review, provenance, and staleness checks. The schema and commands are documented in [memory.md](../memory.md).
