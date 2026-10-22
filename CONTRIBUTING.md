# Contributing

Use Node.js 22 or newer. Run the test suite from a checkout:

```bash
npm ci --ignore-scripts
npm test
```

No live Oura credentials are needed. For manual checks, create a disposable workspace with `--workspace PATH` and use the [invented fixtures](examples/README.md). Keep your real workspace outside the checkout.

Before submitting a change:

1. Run the tests and exercise any changed CLI commands in a disposable workspace.
2. Review staged files for credentials and personal data; follow [SECURITY.md](SECURITY.md).
3. Update the relevant usage guide when behavior changes. Keep README focused on what the project does and how to use it.
4. Record a significant architectural decision in [docs/adr/](docs/adr/README.md) using the next number, the decision date, context, decision, and consequences. Mark superseded decisions and link their replacements.

Bug reports should include the command, Node.js version, expected behavior, actual behavior, and a minimal reproduction using invented data. Do not attach real health records, token JSON, environment dumps, or unredacted logs.
