# Oura OAuth Notes

This repo treats Oura authentication as a connector runtime concern and keeps the health engine independent of raw credentials, provider payloads, and AI-agent integrations.

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

Keep tokens outside the health workspace. The recommended path is `$HOME/.config/health-os/oura-token.json` locally or `/var/lib/health-os/oura-token.json` on a server.

## Supported Inputs

The CLI accepts either:

1. normalized daily payload JSON
2. raw Oura response JSON files fetched by a runtime job
3. an Oura token file that lets the `oura` connector fetch, normalize, and ingest in one command

## Repo Commands

Build an authorization URL:

```bash
./src/scripts/oura-build-auth-url.sh \
  --client-id "$OURA_CLIENT_ID" \
  --redirect-uri "http://localhost:8787/callback" \
  --state "$(openssl rand -hex 16)"
```

Exchange a returned `code` and persist token JSON outside the workspace:

```bash
./src/scripts/oura-exchange-code.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8787/callback" \
  --code "$OURA_CODE" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

Refresh a stored token in place:

```bash
./src/scripts/oura-refresh-token.sh \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
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
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

The legacy Oura-specific command is still supported and uses the same connector internally:

```bash
./src/scripts/oura-sync-from-token.sh \
  --date 2026-04-13 \
  --client-id "$OURA_CLIENT_ID" \
  --client-secret "$OURA_CLIENT_SECRET" \
  --token-file "$HOME/.config/health-os/oura-token.json"
```

The connector refreshes the token first when a `refresh_token` is present, writes the newly returned token back to the token file, then fetches readiness, sleep, and heartrate collections, normalizes them, and ingests the day into `.health-os/`.

If the health workspace already contains prior recovery history, the adapter computes 28-day HRV and resting-HR baselines automatically from `.health-os/data/recovery_snapshots.csv`. A separate baselines file is only needed when bootstrapping from external history.

## Endpoint Assumptions

The live fetch helpers default to these v2 collection paths:

- `/v2/usercollection/daily_readiness`
- `/v2/usercollection/daily_sleep`
- `/v2/usercollection/heartrate`

The OAuth endpoints and required scopes above were checked against Oura's official authentication and error-handling docs on 2026-05-17. The collection paths are the repo defaults for the v2 usercollection flow and can be overridden at runtime with:

- `OURA_READINESS_PATH`
- `OURA_SLEEP_PATH`
- `OURA_HEARTRATE_PATH`
- `OURA_API_BASE_URL`

By default, `oura-fetch-day`, `sync-daily-source --source oura`, and `oura-sync-from-token` tolerate heartrate collection failures and continue with an empty heartrate payload. Set `OURA_STRICT_HEARTRATE=true` if you want missing heartrate data to fail the run.

## Integration Boundary

Agents and external tools should not depend on Oura internals. They should call:

- `sync-daily-source --source oura` to refresh a day
- `validate-daily-state` for externally normalized recovery data
- `ingest-daily-state` only after payload validation succeeds

The reusable connector contract is documented in [health-data-connectors.md](/Users/bknst/Projects/health-os/docs/health-data-connectors.md).

## Error Handling

When the runtime sees Oura auth errors like `401 invalid_token` or `invalid_grant`, it should:

1. stop ingest for that run
2. avoid writing broken payloads into `.health-os/`
3. report that Oura re-authentication is needed
