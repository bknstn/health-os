# ADR 0008: Versioned private workspace and Markdown profile

- Status: Accepted
- Decision date: 2026-10-23

## Context

Health OS source and private state need a stable boundary for independent clones and agent consumers. The workspace already contains user-authored files, so code initialization and schema upgrades must not silently adopt or rewrite an unversioned workspace. A profile needs a deterministic selection rule without creating a second authoritative structured copy of its narrative.

## Decision

Store `schema_version` and an explicit `.health-os`-relative `profile_path` in `.health-os/manifest.json`. Use a Markdown card with minimal `schema_version` and `updated` frontmatter, keeping Markdown authoritative. Initialize a generic card only for a new workspace. Inspect unversioned workspaces without writes and require a deliberate migration, with a dry-run that lists the selected profile and exact files to be written. Validate a selected existing card before writing the manifest; preserve its bytes and all other workspace files.

## Consequences

Independent workspaces resolve their own selected card without filename scanning. Profile reads can be bounded and validated by the CLI, while agents can keep narrative content in ordinary Markdown. Existing unversioned workspaces require an explicit migration, and legacy cards without frontmatter must receive the minimal metadata manually before they can be selected. Schema migrations remain separate from source updates and from future database work.
