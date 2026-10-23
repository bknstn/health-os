# ADR 0010: Profile-scoped HealthEvents and a unified timeline

- Date: 2026-10-23
- Status: Accepted

## Context

Health OS needs a typed, replay-safe place for subjective observations without forcing all health content into a database or mirroring the established workout and recovery CSVs. Events need stable profile identity, preserved time uncertainty and provenance, corrections, supersession, deletion, and bounded cross-source queries. Derived Markdown memory must not continue serving event-derived context after a mutation or a stale idempotency replay.

## Decision

Store new HealthEvent v1 records in a private SQLite database at `.health-os/data/events.sqlite`, scoped to the manifest-selected profile path. Use Node's built-in `node:sqlite` (Node.js 22.13.0 or newer) and strict schema validation. Event identity is a normalized UUID; capture identity is profile + source kind/reference + fragment ID. Writes use SQLite transactions, a required idempotency key, and optimistic expected revisions for correction, supersession, and deletion. Replays resolve to the event's latest replacement or a metadata-only tombstone, so old captures cannot restore superseded or deleted content.

Keep legacy workout/recovery CSVs authoritative and compose them with active events only when reading `timeline`. Do not bulk copy CSV rows into the EventStore. Queries and timeline results have explicit row, field, text, and input bounds; day-only and unknown time retain their stated precision, and timestamp fractions are limited to milliseconds in v1 for deterministic SQLite/JavaScript ordering.

Before committing each event mutation, record the next EventStore generation and the expected event status/revision map in `memory/event-review.json`. Memory context remains blocked until an explicit `context-revalidate-memory --generation N` verifies the current SQLite generation and all event rows, and scans wiki/evidence Markdown for stale, unknown, superseded, or deleted `health-event:<uuid>@<revision>` provenance. This conservative gate invalidates all derived-memory retrieval on any event mutation. Event data is not copied into the generic operation journal.

Deletion scrubs the live row payload and event revision digests but retains capture and request hashes plus a tombstone to prevent replay. This is logical deletion, not forensic erasure: WAL pages and independent backups require their own retention and compaction policy. SQLite transactions do not make writes across legacy CSV files transactional.

## Consequences

- A personal event is queryable and survives process restarts while Markdown remains human-readable and agent-owned.
- Repeated capture processing is idempotent; conflicting source reuse and stale revisions fail rather than silently overwriting facts.
- The event-generation review gate adds a manual review step before derived memory is available after a change.
- The EventStore is only the authority for new events. Existing CSV records retain their current authority.
- Node may still print a SQLite `ExperimentalWarning` on stderr when an event command lazily imports `node:sqlite`; ordinary discovery and legacy commands do not import it.
- Backups containing old SQLite pages are outside the live deletion operation and must follow a separate retention policy.
