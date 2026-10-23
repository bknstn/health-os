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

Use `.health-os/personal/files/` for processed text:

- normalized Markdown medical-test notes
- lab summaries derived from PDFs or images
- curated user context that is safe for tools to read directly

Runtime uploads belong in `.health-os/personal/raw/`; external tools should prefer `.health-os/personal/files/` when they need processed text. Keep both private and outside the source checkout.

An external agent may maintain a personal card and long-form notes as Markdown in `personal/files/`, preserving source references, dates, and uncertainty. The versioned workspace manifest selects exactly one profile path; the default is `personal/files/profile.md`. The CLI does not discover cards by scanning filenames, and other cards remain untouched. The selected card uses `schema_version: 1` and `updated: null` or a real `YYYY-MM-DD` date in its frontmatter. Original uploads remain unchanged in `personal/raw/`. Derived learned observations belong in `memory/wiki/` under its separate metadata rules. See [framework and workspace boundaries](framework-and-workspace.md).

Inspect or validate the selected Markdown profile with:

```bash
node src/cli.js workspace-inspect --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js profile-validate --workspace "$HEALTH_OS_WORKSPACE"
node src/cli.js profile-show --workspace "$HEALTH_OS_WORKSPACE" --max-chars 12000
```

`profile-show` validates the full document and limits returned Markdown to 12,000 characters by default (50,000 maximum). If the selected card is missing or its metadata is invalid, the command exits with an error and does not create or rewrite files.

## Commands

Show the raw upload folder for the active workspace:

```bash
./src/scripts/personal-raw-dir.sh
```

Show the processed files folder for the active workspace:

```bash
./src/scripts/personal-files-dir.sh
```

Import an original upload into `.health-os/personal/raw/`:

```bash
./src/scripts/import-personal-file.sh --file medical-tests.pdf
```

Import with a controlled stored name:

```bash
./src/scripts/import-personal-file.sh --file ~/Downloads/results.md --name 2026-05-17-results.md
```

Import a processed Markdown file into `.health-os/personal/files/`:

```bash
./src/scripts/import-personal-file.sh --file 2026-05-17-results.md --kind processed
```

Imports do not overwrite an existing file by default. Pass `--replace true` only when replacing the stored source document is intentional.

Set `HEALTH_OS_WORKSPACE` or pass `--workspace` when using a non-default workspace.

## Integration Boundary

Raw personal files are source documents. Do not write parsed medical conclusions directly into engine CSVs from raw files without an explicit parser and validation step. Tools should keep the original file intact, derive structured Markdown or structured data separately, and show provenance back to the stored raw file path.
