# Security and privacy

Health OS handles sensitive health records and provider credentials. Use a private workspace outside the source checkout, and keep credentials outside the workspace as well.

## Store and share data safely

- Workspace CSVs, imported documents, generated reports, and memory pages are ordinary files without application-level encryption. Protect them with operating-system permissions and secure backups.
- Keep client secrets in your process environment or a secret manager. Prefer environment variables over credential arguments that may appear in process listings or command history. The CLI does not automatically load `.env` files.
- Store Oura token JSON outside the checkout and workspace. The token writer uses owner-only file permissions (`0600`) and replaces the file atomically.
- `oura-exchange-code` and `oura-refresh-token` print complete token JSON, even when `--token-file` is supplied. Do not capture their stdout in shared logs, screenshots, CI artifacts, or issue reports. Redirect it to `/dev/null` when only the saved file is needed.
- Raw provider exports and command outputs may contain health data. Use the invented [example fixtures](examples/README.md) when reporting problems.
- `.gitignore` prevents ordinary accidental additions; it does not remove tracked files, rewrite history, encrypt files, or prevent `git add -f`.
- External agents receive the data you pass to them. Review their access and retention settings before sharing workspace output.

## Before publishing changes

Review `git status --short` and `git diff --cached`. Check filenames as well as content for personal documents, tokens, private keys, local home paths, and identifying information.

With [Gitleaks](https://github.com/gitleaks/gitleaks) installed, scan the entire reachable history:

```bash
gitleaks git --log-opts="--all" --redact=100 --no-banner .
```

The GitHub Actions workflow runs the tests and the same full-history secret scan. Automated secret detection does not establish that content contains no personal information. Review examples, documents, and Git author/committer metadata separately. Use your GitHub-provided `noreply` email for future commits if you do not want to publish a personal email address.

## Report a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/bknstn/health-os/security/advisories/new) when it is enabled. If it is unavailable, open an issue asking for a private reporting channel without including the vulnerability details, credentials, or health records.

Include a minimal reproduction with invented data, the affected command, and the relevant version. Never include live tokens, patient documents, or an entire workspace.

## If sensitive material was committed

Revoke or rotate any exposed credential first. Removing it in a new commit leaves it readable in earlier commits. Removing historical content or author metadata requires a coordinated history rewrite across affected branches and tags. Forks, existing clones, pull-request references, and cached copies may retain the old content; follow GitHub's [sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
