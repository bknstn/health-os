# Personal Files

Health OS has two workspace-owned folders for user-supplied health documents:

```text
.health-os/personal/raw/
.health-os/personal/files/
```

Use `.health-os/personal/raw/` as the canonical upload inbox. Store original user uploads there unchanged, including:

- PDFs
- screenshots or exported reports
- images
- CSV/XLSX exports
- Markdown files the user directly uploads

Use `.health-os/personal/files/` for processed, agent-ready text:

- normalized Markdown medical-test notes
- lab summaries derived from PDFs or images
- curated user context that is safe for tools to read directly

The repo-level `raw/` folder is legacy source material, not the runtime upload location. Runtime uploads belong in `.health-os/personal/raw/`; agents and tools should prefer `.health-os/personal/files/` when they need LLM-ready text.

## Commands

Show the raw upload folder for the active workspace:

```bash
./scripts/personal-raw-dir.sh
```

Show the processed files folder for the active workspace:

```bash
./scripts/personal-files-dir.sh
```

Import an original upload into `.health-os/personal/raw/`:

```bash
./scripts/import-personal-file.sh --file medical-tests.pdf
```

Import with a controlled stored name:

```bash
./scripts/import-personal-file.sh --file ~/Downloads/results.md --name 2026-05-17-results.md
```

Import a processed Markdown file into `.health-os/personal/files/`:

```bash
./scripts/import-personal-file.sh --file 2026-05-17-results.md --kind processed
```

Imports do not overwrite an existing file by default. Pass `--replace true` only when replacing the stored source document is intentional.

Set `HEALTH_OS_WORKSPACE` or pass `--workspace` when using a non-default workspace.

## Integration Boundary

Raw personal files are source documents. Do not write parsed medical conclusions directly into engine CSVs from raw files without an explicit parser and validation step. Tools should keep the original file intact, derive structured Markdown or structured data separately, and show provenance back to the stored raw file path.
