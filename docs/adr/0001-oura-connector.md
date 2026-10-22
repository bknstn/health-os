# 0001: Oura ingestion behind normalized recovery data

Date: 2026-04-15

Status: Accepted; generalized by [0003](0003-connectors-and-personal-files.md)

## Context

The engine already accepted normalized daily recovery metrics. Live wearable data required OAuth, provider API calls, and a translation from provider responses into the engine's input format.

## Decision

Add Oura authorization, token refresh, daily fetching, and normalization helpers. Validate normalized recovery data before ingestion, and keep provider credentials outside workspace records. Compute HRV and resting-heart-rate baselines from prior workspace history when available.

Deployment helpers initially accompanied this integration. Their runtime-specific setup was later removed as described in [0002](0002-cli-integration-boundary.md).

## Consequences

The same decision engine can consume offline fixtures, externally normalized input, or live Oura data. Provider failures remain an ingestion concern. Oura's response shapes and authentication lifecycle still require dedicated connector maintenance; [0005](0005-detailed-sleep-for-hrv.md) records one such change.
