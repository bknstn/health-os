# 0004: External OAuth token storage with atomic, owner-only writes

Date: 2026-05-17

Status: Accepted

## Context

Refreshing OAuth credentials replaces sensitive token state. Tokens must not leak into health records or become readable by other local users, and interrupted writes should not leave a partially written token file.

## Decision

Keep token JSON outside the repository checkout and health workspace. Write a uniquely named temporary file beside the destination with exclusive creation and mode `0600`, then rename it into place and preserve owner-only permissions. Persist the replacement token returned by a refresh.

## Consequences

The connector can use refreshed credentials without putting them in workspace CSVs, reports, or memory. The filesystem provides the storage boundary; the file is not encrypted. At the time this decision was introduced, token exchange and refresh printed token JSON; [ADR 0009](0009-coordinated-cli-and-machine-contract.md) later changed the current CLI to require a destination by default and made token export explicit. Permission checks and credential lifecycle management remain operational responsibilities. See [SECURITY.md](../../SECURITY.md).
