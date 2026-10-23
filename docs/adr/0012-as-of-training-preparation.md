# ADR 0012: As-of training preparation

- Date: 2026-10-23
- Status: Accepted

## Context

The existing `next` command is a compatibility interface based on the last completed A/B session and legacy recovery decision rows. It does not provide one bounded, reproducible context for a human or an external agent to prepare a session. Historical backfills and future-dated rows can also contaminate decisions unless every input is selected relative to an explicit cutoff. Session assignments and permitted substitutions belong to the private workspace policy, not to runtime-specific prompts.

Preparation also combines evidence with different authority and uncertainty. Structured active subjective facts can inform a deterministic adjustment, while pending or uncertain statements should prompt review without silently becoming facts. Markdown health memory is derived context and must continue to respect the EventStore review gate.

## Decision

Add the read-only `prepare-training --as-of YYYY-MM-DD|RFC3339` command. It returns a bounded machine-readable result for the selected profile, session and plan, eligible workout history, recovery and baseline state, recent subjective events, relevant memory, provenance, and explicit context gaps. A caller may use this same CLI contract from a terminal or a generic agent wrapper; Health OS does not choose when to converse.

Seed `.health-os/config/preparation-policy.json` from the generic source template during workspace initialization, only when the file is absent. The version 1 policy defines weekday session assignments with alternating fallback, explicit session overrides, a bounded allowlist of exercise substitutions, recovery freshness and baseline coverage thresholds, and exact event types, value ranges, freshness windows, and optional set adjustments. Preparation makes no domain-data writes, workspace seeding, idempotency-journal writes, or memory-review mutations. Its read lock and SQLite read connections may create or update auxiliary WAL/SHM files. Invalid or missing policy is reported as an explicit command error.

A date-only cutoff includes that full UTC calendar day. An RFC3339 cutoff uses the exact represented instant. Future records are excluded before query limits are applied. Records with day-only precision are eligible at a date-only cutoff and are excluded from exact-time history on the cutoff day; intervals that cross an exact cutoff are excluded. Profile and configuration values are read as the workspace's current snapshot; Health OS does not reconstruct historical profile or policy versions.

Only recent, active, low-uncertainty `fact` events with a configured event type and an in-range value can adjust a preparation. The latest eligible fact for an event type governs its adjustment, so repeated reports do not stack the same change and a later normal value supersedes an earlier low value. Pending or higher-uncertainty events remain visible as signals and do not apply the configured adjustment. These rules express input quality and configured training policy, not a medical interpretation.

Recovery is decision-available only when the selected data is fresh and its required baseline coverage meets the configured minimum. A provider-neutral observation set can drive recovery when it contains fresh HRV, resting heart rate, readiness and sleep scores and adequate same-source baselines. Physical-only or scoreless observations do not yield a recovery decision. Legacy daily-state rows can be used only when policy explicitly allows their unscoped baselines; this is disabled by default. Missing, stale, insufficient, or uncertain evidence is returned as a gap; a prior score is not copied forward and a missing baseline is not presented as an established personal norm. If recovery is unavailable, the workout is returned with `scheduled_only: true` and mode `UNAVAILABLE`, so callers can distinguish a schedule candidate from a supported recommendation.

Before returning derived Markdown memory, preparation verifies EventStore/review-generation consistency and current event provenance. If memory is pending, inconsistent, or contains stale provenance, preparation returns an explicit blocked memory status without exposing derived page text. Direct structured events remain separately identified and may still be returned under their event contract.

The existing `next`, `today`, and recovery-ingestion behavior remain compatible. Training preparation is a separate read-only decision-context operation. It does not call external services, model providers, or schedulers.

## Consequences

- A terminal caller and a generic agent wrapper can consume the same deterministic result and provenance references.
- Session selection, substitutions, freshness, baseline coverage, and subjective adjustments are reviewable in private workspace configuration.
- As-of queries cannot use future sessions, measurements, events, or evidence to justify an earlier decision.
- Callers must act on missing/stale/uncertain gaps themselves; the command does not ask questions or fill missing values.
- Profile and configuration history is not versioned, so as-of reconstruction applies to dated health records and evidence while using the current profile and policy snapshot.
- Preparation may derive a decision from eligible legacy recovery or sufficiently covered scored observations; physical-only observations do not imply readiness.
- Missing profile content is an explicit gap, while a missing or invalid preparation policy is a command error.
