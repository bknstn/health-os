# Development and contributing

Use **Node.js 22.13.0 or newer**. The CLI and examples use Node built-ins; no dependency installation is needed to run them. The package is private and is not published to npm.

## Local checks

Run the test suite from the repository root:

```bash
npm ci --ignore-scripts
npm test
```

`npm ci` is optional for a conventional clean CI setup. Tests use local fixtures and mocked provider responses; they do not require Oura credentials.

For manual checks, create a disposable workspace with `--workspace PATH` and use the [invented fixtures](../examples/README.md). Keep your real workspace outside the checkout. The [compatibility guide](compatibility.md) describes focused source and workspace checks.

## Before submitting a change

1. Run the tests and exercise any changed CLI commands in a disposable workspace.
2. Review staged files for credentials and personal data; follow [security and privacy guidance](../SECURITY.md).
3. Update the relevant usage guide when behavior changes. Keep the root README focused on the concept, one complete workflow, and a minimal quick start; put reference material and technical details in `docs/`.
4. Record a significant architectural decision in [the ADR directory](adr/README.md) using the next number, the decision date, context, decision, and consequences. Mark superseded decisions and link their replacements.

## Reporting an issue

Bug reports should include the command, Node.js version, expected behavior, actual behavior, and a minimal reproduction using invented data. Do not attach real health records, token JSON, environment dumps, or unredacted logs.
