# 0005: Fetch detailed sleep data for Oura HRV

Date: 2026-05-24

Status: Accepted

## Context

Daily sleep summaries were insufficient for the adapter's required HRV and resting-heart-rate inputs. The live fetch path needed detailed sleep records while preserving the existing normalized contract.

## Decision

Fetch the detailed `/v2/usercollection/sleep` collection alongside daily readiness and sleep summaries. Query the previous date through the target date, select the target day's long-sleep record with HRV when available, and merge HRV, lowest heart rate, sleep duration, and efficiency into the daily sleep record before normalization.

Treat the detailed fetch as optional, allowing already enriched inputs to continue working. Normalization still fails when required metrics are absent.

## Consequences

The engine and consumer CLI contract stay unchanged. Live synchronization needs an additional API request. A failed detailed request can result in a missing-metric validation error later in the flow; it does not justify inventing HRV values.
