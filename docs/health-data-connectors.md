# Health Data Connectors

Health OS separates provider harvesting from health decisions.

The engine accepts one stable payload: the normalized recovery contract validated by `src/recovery-contract.js`. Wearables, lab imports, manual forms, and future integrations should be implemented as connectors that produce that payload. AI agents and other tools should depend on this contract or on CLI commands that expose it, not on provider-specific Oura, Whoop, or Garmin code.

User-uploaded source documents belong in `.health-os/personal/raw/`; processed Markdown and text for agents belongs in `.health-os/personal/files/`. See [personal-files.md](/Users/bknst/Projects/health-os/docs/personal-files.md). A connector or parser may read either layer, but it should preserve provenance and still emit the normalized contract before ingestion.

## Connector Contract

A connector lives under `src/*-connector.js` and is registered in `src/health-data-connectors.js`.

Each connector must expose:

- `id`: stable machine name, for example `oura`
- `label`: human-readable source name
- `capabilities`: supported source features, for example `daily-recovery`
- `requiredMetrics`: normalized metrics the connector can provide
- `resolveAuth({ options, env })`: loads credentials or tokens without writing them to the workspace
- `fetchDaily({ date, options, env, auth })`: returns a raw provider bundle for one calendar day
- `normalizeDaily({ date, rawBundle, baselines })`: maps the raw bundle to the recovery contract
- `writeRawBundle({ outputDir, rawBundle })`: optional raw export for debugging or replay

The generic ingestion path is:

```text
provider credentials -> connector.fetchDaily -> connector.normalizeDaily -> validateRecoveryPayload -> ingestDailyState
```

## Stable Consumer Interface

Use the provider-neutral command when an external tool needs to refresh a user's daily state:

```bash
./scripts/sync-daily-source.sh --source oura --date 2026-04-13 --token-file "$HOME/.config/health-os/oura-token.json"
```

List available connectors:

```bash
node src/cli.js connectors
```

Validate a normalized payload without ingesting it:

```bash
cat daily-state.json | ./scripts/validate-daily-state.sh
```

Ingest a normalized payload from any source:

```bash
cat daily-state.json | ./scripts/ingest-daily-state.sh
```

## Adding A Wearable

1. Create a connector module, for example `src/whoop-connector.js`.
2. Implement the connector contract above.
3. Register it with `registerHealthDataConnector()` in `src/health-data-connectors.js`.
4. Add fixture-based tests that prove raw provider JSON normalizes into the recovery contract.
5. Prefer `sync-daily-source --source <id>` for runtime ingestion.

Provider authentication can be OAuth, personal access token, local file import, or an upstream service token. Keep credentials outside `.health-os/`; the workspace is for derived user state and artifacts.

## Agent Integration Boundary

Hermes, MCP servers, chat agents, dashboards, and cron jobs should treat Health OS as a local health data service:

- call `sync-daily-source` to harvest a provider day
- call `validate-daily-state` before sending externally normalized data
- call `today`, `why`, and `weekly-summary` for read-only briefs
- avoid importing provider adapters directly unless implementing a connector

This keeps Health OS reusable even when the caller is not an AI agent.
