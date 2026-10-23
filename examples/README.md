# Example data

The JSON files in this directory use deliberately invented numbers and dates. They demonstrate formats and scoring behavior; they are not personal health records, provider account exports, or training targets.

- `recovery/normalized-good-day.json` demonstrates a `FULL` recommendation on 2026-04-13.
- `recovery/normalized-bad-day.json` demonstrates a `LIGHT` recommendation on 2026-04-14.
- `oura/` demonstrates minimal provider-shaped responses and baseline inputs for offline normalization. `sleep-response.json` represents the merged sleep data consumed by the adapter, rather than a complete raw Oura API response.

Use a separate demo workspace when ingesting these files. Never replace them with real wearable exports, identifiers, lab results, or credentials.

## Runnable offline examples

From the repository root, create a disposable workspace and call the generic CLI wrapper with synthetic state. The trap removes this workspace when the shell exits:

```bash
set -eu
demo_root="$(mktemp -d)"
trap 'rm -rf "$demo_root"' EXIT
node src/cli.js init-workspace --workspace "$demo_root/workspace"
node examples/generic-agent-caller.mjs "$demo_root/workspace" --as-of 2026-10-23 --session A
node examples/connectors/fixture-connector.mjs
```

The subprocess caller validates `capabilities`, the JSON envelope, the preparation schema, and output bounds, then prints only a small summary. The connector example explicitly registers a synthetic fixture connector, writes two made-up physical observations into its own disposable workspace, and confirms that physical-only inputs do not create a recovery score. Neither example accesses a provider or uses credentials. See the [agent runbook](../docs/agent-integration-runbook.md) and [connector guide](../docs/health-data-connectors.md) for the contracts they demonstrate.
