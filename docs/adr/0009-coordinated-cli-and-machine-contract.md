# ADR 0009: Coordinated CLI and machine contract

- Status: Accepted
- Decision date: 2026-10-23

## Context

Health OS is called as a subprocess by humans and external agents. A consumer needs versioned capability discovery, bounded results, clear stream and exit behavior, and safe retries. The CLI's current file stores must remain usable without adding a database or requiring every external caller to coordinate perfectly. Several operations also share files outside the workspace, especially rotating OAuth tokens and optional raw provider bundles.

## Decision

Keep human output as the default and add one opt-in, versioned JSON envelope for every command. Provide `version` and `capabilities` commands that describe supported command subsets, payloads, idempotency, locks, and bounds. Read-only discovery and validation commands do not initialize workspaces. JSON stdin is an explicit bare-payload contract for workout and recovery operations.

Serialize covered workspace operations with a process lock keyed to the canonical physical `.health-os` path. Use per-file sibling-temp atomic replacement. Use separate canonical resource locks for token files and shared raw output paths; hold the token lock across token read/refresh/write. Never evict locks by age: when a process dies while holding one, fail closed and require manual inspection/recovery.

Accept idempotency keys only for the documented workspace command subset. Journal a request digest before executing; include effective options/date and payload or file bytes/name. Return the completed result on an exact replay, reject digest conflicts, and leave interrupted pending requests for inspection instead of repeating an uncertain write. Keep token export explicit and require a token-file destination for exchange/refresh by default.

## Consequences

External consumers can discover a stable command contract and use bounded subprocess results without importing internal modules. Covered Health OS writers coordinate across processes and symlink aliases, and rotating-token refreshes coordinate across workspaces. File replacement protects each file independently; multi-file legacy CSV and raw-bundle operations remain nontransactional and can be partial after a process crash. A local token lock cannot make provider-side single-use token rotation plus local file replacement a distributed transaction; a crash or storage failure after provider success may require reauthorization. External programs that bypass the CLI locks are outside this coordination contract. Stale locks require deliberate operator recovery. Default token output no longer exposes token values; deliberate export remains available with an explicit flag.
