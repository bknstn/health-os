# ADR 0011: Provider-neutral wearable observations

- Date: 2026-10-23
- Status: Accepted

## Context

The legacy recovery contract requires proprietary readiness and sleep scores and feeds the existing training decision engine. That contract is useful for compatibility, but it cannot represent a source that supplies physical readings without those scores. Requiring every device to manufacture a score or appear decision-ready would misstate what the source observed. A reusable connector boundary also needs source-specific provenance, actual sample precision, missingness, freshness, and baseline coverage.

## Decision

Define HealthObservationSet v1 with separate `physical_metrics` and `proprietary_scores` arrays. Each metric carries its unit, source reference, missingness state, and nullable exact timestamp or source day. Set-level freshness is explicit and cannot be treated as the timestamp of every metric. Baseline values report distinct sample-day coverage, source scope, and units; observation baselines use only prior same-source samples, count actual known sample days in a UTC window, and reject mixed units or conflicting same-day values. Unknown timestamps, empty CSV values, and the current day's sample do not become baseline coverage.

Store one complete current set per connector/date in the private versioned `.health-os/data/wearable-observations.json` file. Replacing a source/date set removes old metric values so a missing update cannot leave a stale reading. Validate before writes, use atomic file replacement, and route CLI ingestion through the shared workspace lock and operation idempotency journal. Expose read-only validation and bounded query commands.

Keep connector registration explicit. Observation-capable connectors declare schema versions, the exact physical metric IDs, and the exact proprietary score IDs their normalizer returns. Registration and normalization reject unsupported versions, duplicate/cross-category IDs, and undeclared output. Connectors may implement both the new observation normalizer and the existing normalized recovery normalizer.

Oura implements both contracts. Its observation normalizer separates physical measures from readiness/sleep scores and marks missing scores explicitly. The established legacy recovery normalizer and decision behavior remain compatible, including its prior baseline handling. Legacy recovery CSVs do not have dependable provider IDs, so they are not imported into source-scoped observation baselines. A scoreless or otherwise incomplete observation sync stores physical data and reports `decision_available: false`; it does not write a new daily recovery decision. Existing daily recovery and timeline authority remain unchanged.

## Consequences

- A connector with useful physical readings can participate without proprietary scores, while the old Oura and normalized-recovery interfaces remain available.
- Consumers must check `decision_available`; success from an observation-only sync is not a training recommendation, and a previous legacy row can still be present.
- Repeated source/date observations replace the whole set, while cross-file writes to legacy recovery and the observation store are not one transaction.
- Baselines from legacy recovery CSVs remain usable by the legacy path, but are not silently treated as same-provider history for observation sets.
- New provider integrations still require deliberate source changes and fixture tests; no live device API or automatic plugin discovery is introduced by this decision.
