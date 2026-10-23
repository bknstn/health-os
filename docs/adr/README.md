# Architecture decision records

These records describe significant architectural decisions. The root [README](../../README.md) and usage guides describe the current interface.

| ADR | Decision date | Decision | Status |
| --- | --- | --- | --- |
| [0000](0000-file-based-training-engine.md) | 2026-04-14 | Deterministic training engine with file-based workspace state | Accepted; original runtime integration superseded by 0002 |
| [0001](0001-oura-connector.md) | 2026-04-15 | Oura ingestion behind normalized recovery data | Accepted; generalized by 0003 |
| [0002](0002-cli-integration-boundary.md) | 2026-05-17 | CLI as the independent integration boundary | Accepted |
| [0003](0003-connectors-and-personal-files.md) | 2026-05-17 | Provider-neutral connectors and separate personal-file areas | Accepted |
| [0004](0004-external-oauth-token-storage.md) | 2026-05-17 | External token storage with atomic, owner-only writes | Accepted |
| [0005](0005-detailed-sleep-for-hrv.md) | 2026-05-24 | Fetch detailed sleep data for Oura HRV | Accepted |
| [0006](0006-file-native-memory.md) | 2026-07-19 | Derived Markdown memory for external agents | Accepted |
| [0008](0008-versioned-private-workspace-and-profile.md) | 2026-10-23 | Versioned private workspace with an explicitly selected Markdown profile | Accepted |
| [0009](0009-coordinated-cli-and-machine-contract.md) | 2026-10-23 | Bounded machine interface with idempotent, coordinated local writes | Accepted |
| [0010](0010-health-event-store-and-timeline.md) | 2026-10-23 | Profile-scoped SQLite events with a bounded legacy-composing timeline | Accepted |
| [0011](0011-provider-neutral-wearable-observations.md) | 2026-10-23 | Provider-neutral wearable observations beside the compatible legacy recovery path | Accepted |
| [0012](0012-as-of-training-preparation.md) | 2026-10-23 | As-of training preparation with workspace policy and explicit evidence gaps | Accepted |

## Adding a record

Use the next number (`0013`), a descriptive filename, and the date the decision takes effect. Include status, context, decision, and consequences. Explain the reason and tradeoffs, rather than listing changed files. If a decision is replaced, retain the old record, mark it superseded, and link the replacement.

Keep credentials, personal health information, private deployment details, and local user paths out of every record.
