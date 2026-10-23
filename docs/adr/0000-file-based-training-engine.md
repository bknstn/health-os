# 0000: Deterministic training engine with file-based state

Date: 2026-04-14

Status: Accepted; original runtime integration superseded by [0002](0002-cli-integration-boundary.md)

## Context

The initial tracker needed structured workout logging, an alternating training plan, recovery scoring, progression, and readable daily and weekly output. An external agent initially supplied messaging, group isolation, and scheduling.

## Decision

Keep training and recovery calculations in a deterministic Node.js engine. Store mutable state under a selected workspace's `.health-os/` directory: CSV for structured records, JSON for configuration, and Markdown for generated reports. Copy repository defaults only when workspace configuration is missing.

The initial deployment mounted the code as a toolset for the external runtime. The runtime owned transport and scheduling; Health OS owned health logic and state.

## Consequences

Records and scoring inputs remain inspectable, and the engine can run without a database service or model provider. Workspace data can be separated from source code. File writes need coordination; this storage model does not provide database transactions, concurrent writers, or encryption. The runtime-specific integration was later removed from the supported interface by ADR 0002.
