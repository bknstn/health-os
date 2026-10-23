# 0002: CLI as the independent integration boundary

Date: 2026-05-17

Status: Accepted

## Context

Early documentation and deployment templates assumed a specific external runtime, messaging transport, and host setup. Those assumptions made a reusable training engine look tied to one caller and obscured the distinction between repository code and private runtime state.

## Decision

Expose supported operations through `node src/cli.js <command>` and matching wrappers under `src/scripts/`. External agents, schedulers, and other callers use this interface. Remove bundled messaging, host-specific, and service-manager scaffolding from the maintained project surface.

Select a workspace with `--workspace`. Shell wrappers also read `HEALTH_OS_WORKSPACE`. Keep transport, scheduling, and agent orchestration in the calling system.

## Consequences

Health OS can be used from a terminal or different agent frameworks with the same commands. Callers are responsible for scheduling, handling exit statuses, and coordinating writes. Provider modules remain implementation interfaces for connector development, rather than integration APIs for agents.

This supersedes the runtime-specific deployment portion of [0000](0000-file-based-training-engine.md) and [0001](0001-oura-connector.md).
