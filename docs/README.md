# Health OS documentation

Health OS is a local, CLI-first foundation for personal health workflows. Any agent that can invoke a command can use the same workspace and versioned JSON contract.

## Start here

- [Getting started](getting-started.md): installation, workspace setup, and a complete training/recovery loop.
- [CLI reference](cli-reference.md): commands, input/output, write behavior, and coordination.
- [Agent integration runbook](agent-integration-runbook.md): machine contracts, payload examples, events, preparation, and a generic subprocess caller.
- [Synthetic examples](../examples/README.md): offline fixtures and runnable demonstrations.

## Data and integrations

- [Framework and workspace boundaries](framework-and-workspace.md): profiles, storage ownership, events, observations, and extension points.
- [Health data connectors](health-data-connectors.md): provider-neutral observations and the recovery contract.
- [Oura OAuth and sync](oura-oauth.md): authorization, token storage, and provider commands.
- [Personal files](personal-files.md): original documents and processed notes.
- [Memory](memory.md): evidence bundles, agent-maintained notes, retrieval, and provenance.
- [Workspace backup and restore](workspace-backup-restore.md): coherent backups, restoration, and export.
- [Compatibility](compatibility.md): source upgrades, workspace migration, and caller checks.
- [Security and privacy](../SECURITY.md): sensitive records, credentials, and vulnerability reporting.

## Development

- [Development and contributing](development.md): local checks, contribution guidelines, and reporting issues.
- [Architecture decision records](adr/README.md): design decisions and their consequences.
