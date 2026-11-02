# Quota recorder

The pool charts on the Quota Management page need history; the Management API
only knows each credential's quota *now*. The recorder is a small sidecar that
samples every subscription credential on a schedule and serves the history.

It reuses the panel's own provider data layers (`src/features/quota/providers/*/data.ts`),
so it records exactly what the quota cards show. API-key providers (Mistral,
OpenRouter) are skipped: their checks send a real completion request.

## Build

```sh
bun build recorder/main.ts --target bun --minify-syntax --outfile dist-recorder/quota-recorder.js
```

Releases also attach `quota-recorder.js`.

## Run (Docker Compose, next to the proxy)

Give the proxy an extra management key through `MANAGEMENT_PASSWORD` and hand
the same value to the recorder:

```yaml
services:
  cli-proxy-api:
    environment:
      MANAGEMENT_PASSWORD: ${QUOTA_RECORDER_KEY}
  quota-recorder:
    image: oven/bun:1-alpine
    restart: unless-stopped
    command: ["bun", "/app/quota-recorder.js"]
    environment:
      CPA_URL: http://cli-proxy-api:8317
      CPA_KEY: ${QUOTA_RECORDER_KEY}
      DATA_DIR: /data
      INTERVAL_MINUTES: "10"
    ports:
      - "127.0.0.1:8318:8318"
    volumes:
      - ./quota-recorder:/app:ro
      - ./quota-history:/data
```

| Variable           | Default  | Meaning                                         |
| ------------------ | -------- | ----------------------------------------------- |
| `CPA_URL`          | required | Proxy base URL                                  |
| `CPA_KEY`          | required | Management key the recorder polls with          |
| `DATA_DIR`         | `./data` | Daily `YYYY-MM-DD.jsonl` snapshot files         |
| `PORT`             | `8318`   | HTTP port                                       |
| `INTERVAL_MINUTES` | `10`     | Poll interval                                   |
| `RETENTION_DAYS`   | `120`    | Older day files are deleted                     |

Credentials that return 429/401/403 back off (up to 2 h); credentials with no
quota window are retried every 6 h.

## HTTP

All routes except `/health` need `Authorization: Bearer <management key>`. Any
key the proxy accepts works; the recorder verifies unknown keys against the
Management API, forwarding at most three failures per 30 minutes so a wrong key
in a browser can never get the recorder's own IP banned by the proxy.

- `GET /health`: poll interval and last poll time
- `GET /history?from=<ms>&to=<ms>`: snapshots in range (max 62 days)
- `GET /status`: per-credential backoff and last error
- `POST /poll`: poll now (ignored within 2 minutes of the previous poll)

The panel finds the recorder at the proxy's host on port 8318; override it
under **Accounts → Recorder URL** on the Quota Management page.
