# Oura OAuth setup

This repo treats Oura authentication as a connector runtime concern and keeps the health engine independent of raw credentials, provider payloads, and caller-specific integrations.

## Official Oura References

- Oura support overview: [The Oura API](https://support.ouraring.com/hc/en-us/articles/4415266939155-The-Oura-API)
- Oura authentication docs: [Authentication](https://cloud.ouraring.com/docs/authentication)
- Oura error handling docs: [Error Handling](https://cloud.ouraring.com/docs/error-handling)

## Working Assumptions

Based on the official docs above:

- Oura uses OAuth2
- access tokens are exchanged at `https://api.ouraring.com/oauth/token`
- authorization starts at `https://cloud.ouraring.com/oauth/authorize`
- the default requested scopes for this tracker are `daily` and `heartrate`
- refresh tokens are single-use and must be replaced with the newly returned refresh token after each refresh

Inference:

- `daily` is the hard requirement because Oura documents it as the scope for daily sleep, activity, and readiness summaries
- `heartrate` is recommended for a better resting-HR fallback, but the sync can continue without it when sleep data already includes the needed heart-rate field

## Credential Boundary

This repo does not store:

- client secret
- access token
- refresh token

Keep tokens outside the repository checkout and health workspace. The recommended path is `$HOME/.config/health-os/oura-token.json` locally or `/var/lib/health-os/oura-token.json` on a server. Token exchange and refresh require a token-file destination by default and print only storage metadata. Use `--export-token true` only when deliberately handling token contents. See [SECURITY.md](../SECURITY.md).

## Prerequisites

1. Register an application in [Oura's application settings](https://cloud.ouraring.com/oauth/applications).
2. Register `http://localhost:8787/callback` as a redirect URI for local use.
3. Supply `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` through your process environment or secret manager. The CLI does not automatically load `.env` files. Avoid putting literal secrets in shell commands or shared logs.
4. Initialize a private workspace as described in the [README](../README.md#quick-start).

Choose the token location and generate a state value for this authorization attempt:

```bash
export OURA_TOKEN_FILE="$HOME/.config/health-os/oura-token.json"
export OURA_REDIRECT_URI="http://localhost:8787/callback"
export OURA_STATE="$(openssl rand -hex 16)"
```

Build the authorization URL with the command below. In another terminal with the same environment and state value, start the local callback listener before opening the URL:

```bash
./src/scripts/oura-listen-callback.sh
```

Complete authorization in your browser. The listener verifies the supplied state and saves the token file. This flow does not require manually copying the authorization code. The direct exchange and refresh commands below are alternatives for callers that manage those steps themselves; verify the returned state before a manual code exchange.

## Supported Inputs

The CLI accepts either:

1. normalized daily payload JSON
2. raw Oura response JSON files fetched by a runtime job
3. an Oura token file that lets the `oura` connector fetch, normalize, and ingest in one command

## Repo Commands

Build an authorization URL:

```bash
./src/scripts/oura-build-auth-url.sh \
  --redirect-uri "$OURA_REDIRECT_URI" \
  --state "$OURA_STATE"
```

For a manual exchange, supply the returned code as `OURA_CODE` in the environment after verifying the state. Persist token JSON outside the workspace:

```bash
./src/scripts/oura-exchange-code.sh \
  --token-file "$OURA_TOKEN_FILE"
```

Refresh a stored token in place:

```bash
./src/scripts/oura-refresh-token.sh \
  --token-file "$OURA_TOKEN_FILE"
```

Fetch raw Oura collections for one day:

```bash
./src/scripts/oura-fetch-day.sh \
  --date 2026-04-13 \
  --token-file "$HOME/.config/health-os/oura-token.json" \
  --output-dir /tmp/oura-2026-04-13
```

Normalize fetched Oura JSON:

```bash
./src/scripts/normalize-oura-json.sh \
  --date 2026-04-13 \
  --readiness-file /tmp/oura-2026-04-13/readiness.json \
  --sleep-file /tmp/oura-2026-04-13/sleep.json \
  --heartrate-file /tmp/oura-2026-04-13/heartrate.json
```

Fetch, normalize, and ingest through the provider-neutral connector command:

```bash
./src/scripts/sync-daily-source.sh \
  --source oura \
  --date 2026-04-13 \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

The legacy Oura-specific command is still supported and uses the same connector internally:

```bash
./src/scripts/oura-sync-from-token.sh \
  --date 2026-04-13 \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

The connector refreshes the token first when a `refresh_token` is present, writes the newly returned token back to the token file, then fetches readiness, sleep, and heartrate collections, normalizes them, and ingests the day into `.health-os/`. Local token-file locking prevents overlapping Health OS refreshes, but the provider's single-use token rotation and local replacement are not one distributed transaction; a crash or storage failure after provider success may require reauthorization.

If the health workspace already contains prior recovery history, the adapter computes 28-day HRV and resting-HR baselines automatically from `.health-os/data/recovery_snapshots.csv`. A separate baselines file is only needed when bootstrapping from external history.

## Endpoint Assumptions

The live fetch helpers default to these v2 collection paths:

- `/v2/usercollection/daily_readiness`
- `/v2/usercollection/daily_sleep`
- `/v2/usercollection/sleep` (detailed sleep metrics, merged before normalization)
- `/v2/usercollection/heartrate`

The OAuth endpoints and scope descriptions above were checked against Oura's official authentication docs on 2026-10-22. These collection paths describe the current implementation; readiness, daily sleep, and heartrate paths can be overridden at runtime with:

- `OURA_READINESS_PATH`
- `OURA_SLEEP_PATH`
- `OURA_HEARTRATE_PATH`
- `OURA_API_BASE_URL`

By default, `oura-fetch-day`, `sync-daily-source --source oura`, and `oura-sync-from-token` tolerate heartrate collection failures and continue with an empty heartrate payload. Set `OURA_STRICT_HEARTRATE=true` if you want missing heartrate data to fail the run.

## Integration Boundary

External tools should not depend on Oura internals. They should call:

- `sync-daily-source --source oura` to refresh a day
- `validate-daily-state` for externally normalized recovery data
- `ingest-daily-state` only after payload validation succeeds

The reusable connector contract is documented in [health-data-connectors.md](health-data-connectors.md).

## Error Handling

When the runtime sees Oura auth errors like `401 invalid_token` or `invalid_grant`, it should:

1. stop ingest for that run
2. avoid writing broken payloads into `.health-os/`
3. report that Oura re-authentication is needed
