# 0003: Provider-neutral connectors and separate personal-file areas

Date: 2026-05-17

Status: Accepted

## Context

Consumers needed a stable way to ingest recovery data without depending on Oura internals. Original health documents and processed text also needed explicit workspace locations with preserved provenance.

## Decision

Register providers behind a shared connector contract: resolve authentication, fetch one day, normalize the response, and optionally export raw provider data. Expose `sync-daily-source --source <id>` and validate its normalized payload before storing it. Retain the Oura-specific sync command as a compatibility entrypoint.

Keep original documents in `.health-os/personal/raw/` and processed text in `.health-os/personal/files/`. Imports preserve the source file and reject overwrites unless replacement is explicitly requested.

## Consequences

Additional providers can reuse the engine's normalized recovery contract. Oura remains the only built-in provider. Personal document storage does not itself extract metrics or produce medical conclusions; a parser and validation step are required before structured ingestion. Uploaded documents and derived notes remain private workspace data.
