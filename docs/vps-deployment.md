# VPS Deployment

This is the production-oriented deployment shape for `health-os` on a VPS, with NanoClaw running on the same host.

## Recommended Layout

- `health-os` repo at `/srv/health-os`
- NanoClaw repo at `/srv/nanoclaw`
- runtime env file at `/etc/health-os/runtime.env`
- Oura token file at `/var/lib/health-os/oura-token.json`
- dedicated service user such as `healthos`

The mutable tracker state still lives in the NanoClaw group workspace, not in the `health-os` repo checkout.

## Runtime Env

Start from the example env file and adapt it for the VPS:

```bash
cp /srv/health-os/examples/runtime/health-os.env.example /etc/health-os/runtime.env
```

Important values:

- `NANOCLAW_ROOT=/srv/nanoclaw`
- `HEALTH_OS_ROOT=/srv/health-os`
- `HEALTH_OS_WORKSPACE=<path to the NanoClaw health group folder>`
- `OURA_TOKEN_FILE=/var/lib/health-os/oura-token.json`
- `OURA_CALLBACK_HOST=127.0.0.1`
- `OURA_CALLBACK_PORT=8787`
- `OURA_REDIRECT_URI=https://your-domain.example/oura/callback`

Validate before installing units:

```bash
/srv/health-os/scripts/check-runtime-env.sh --env-file /etc/health-os/runtime.env
```

## Render systemd Units

Generate unit files from the repo templates:

```bash
/srv/health-os/scripts/render-systemd-units.sh \
  --env-file /etc/health-os/runtime.env \
  --output-dir /tmp/health-os-systemd \
  --run-as-user healthos \
  --on-calendar '*-*-* 06:30:00'
```

This creates:

- `health-os-refresh.service`
- `health-os-refresh.timer`
- `health-os-oura-callback.service`

Install them:

```bash
sudo cp /tmp/health-os-systemd/*.service /etc/systemd/system/
sudo cp /tmp/health-os-systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now health-os-refresh.timer
```

## What The Units Do

- `health-os-refresh.service` runs host-side Oura sync and refreshes the `today.md` and `weekly.md` artifacts
- `health-os-refresh.timer` runs that service on schedule and catches up after downtime with `Persistent=true`
- `health-os-oura-callback.service` listens for the Oura OAuth redirect and stores the token file

## Reverse Proxy For OAuth Callback

If `OURA_REDIRECT_URI` points at `https://your-domain.example/oura/callback`, proxy that path to the local callback listener on `127.0.0.1:8787`.

Example Nginx snippet:

```nginx
location /oura/callback {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Server-Side OAuth Flow

1. Start the callback listener:

```bash
sudo systemctl start health-os-oura-callback.service
```

2. Build the authorization URL:

```bash
set -a
. /etc/health-os/runtime.env
set +a

/srv/health-os/scripts/oura-build-auth-url.sh
```

3. Open the URL and approve access.
4. Oura redirects to the VPS callback path.
5. The callback service stores the token in `OURA_TOKEN_FILE` and exits.

If you want strict OAuth state validation, set `OURA_STATE` in `/etc/health-os/runtime.env` before starting the callback service, then rebuild the authorization URL with the same env loaded.

Inspect logs if needed:

```bash
sudo journalctl -u health-os-oura-callback.service -n 50 --no-pager
```

## Daily Sync On The VPS

The refresh service runs:

```bash
/srv/health-os/scripts/vps-refresh.sh
```

That internally:

- refreshes the Oura token if needed
- ingests the current day into the health workspace
- regenerates `today.md`
- regenerates `weekly.md`

Manual run:

```bash
set -a
. /etc/health-os/runtime.env
set +a

/srv/health-os/scripts/vps-refresh.sh
```

## NanoClaw Boundary

NanoClaw still owns:

- the Telegram bot token
- the health chat registration
- message handling
- scheduled agent prompts if you want proactive daily briefs inside Telegram

`health-os` on the VPS owns:

- Oura token storage
- scheduled sync
- artifact generation

The clean split is: NanoClaw orchestrates chats, `health-os` handles recovery/training state and the Oura sync path.
