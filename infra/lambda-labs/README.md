# Lambda Labs Deploy Studio Runtime

This folder prepares the Video Lab API to call a Deploy Studio instance running
LTX Sulphur on a Lambda Labs GPU host.

## Target Architecture

Browser -> Firebase Hosting -> Video Lab API -> Deploy Studio HTTPS facade -> LTX Sulphur GPU worker

The browser must never call the Lambda Labs instance directly. The API keeps
credits, identity, queueing, idempotency, and the runtime token server-side.

## Provisioning Process

1. Launch a Lambda Labs GPU instance with an image compatible with the Deploy
   Studio/LTX Sulphur runtime. Prefer an image with NVIDIA drivers and Docker
   already installed.
2. Attach the project SSH key and restrict inbound firewall rules to SSH and
   the HTTPS reverse proxy. Keep the raw runtime port private where possible.
3. Install or copy Deploy Studio onto the instance. Its local service should
   expose a small HTTP facade with these operations:
   - `GET /health`
   - `POST /generations`
   - `GET /generations/{jobId}`
   - `POST /generations/{jobId}/cancel`
   - `GET /generations/{jobId}/output`
4. Run `bootstrap-deploy-studio.sh` on the instance with the command that starts
   Deploy Studio. Example:

   ```bash
   sudo DEPLOY_STUDIO_START_COMMAND='docker compose up -d' \
     ./bootstrap-deploy-studio.sh
   ```

5. Put TLS in front of the runtime. `Caddyfile.example` is a minimal reverse
   proxy for a DNS name pointed at the instance.
6. Generate a high-entropy runtime API token and configure Deploy Studio or the
   proxy to require it.
7. Configure the Video Lab API environment from
   `video-lab-runtime.env.example`. For Firebase Functions, set the token as a
   secret and all non-secret values as function environment config.
8. Run the smoke test before exposing the runtime to users:

   ```bash
   VIDEO_RUNTIME_PROVIDER=sulphur-ltx \
   VIDEO_RUNTIME_BASE_URL=https://ltx-runtime.example.intelligensi.ai \
   VIDEO_RUNTIME_API_TOKEN=... \
   VIDEO_RUNTIME_PAYLOAD_MODE=deploy-studio \
   /usr/local/bin/node node_modules/tsx/dist/cli.mjs scripts/runtime-smoke.ts
   ```

## Firebase Wiring

The API reads these variables:

- `VIDEO_RUNTIME_PROVIDER=sulphur-ltx`
- `VIDEO_RUNTIME_BASE_URL`
- `VIDEO_RUNTIME_API_TOKEN`
- `VIDEO_RUNTIME_HEALTH_PATH`
- `VIDEO_RUNTIME_SUBMIT_PATH`
- `VIDEO_RUNTIME_STATUS_PATH`
- `VIDEO_RUNTIME_CANCEL_PATH`
- `VIDEO_RUNTIME_OUTPUT_PATH`
- `VIDEO_RUNTIME_AUTH_HEADER`
- `VIDEO_RUNTIME_AUTH_SCHEME`
- `VIDEO_RUNTIME_PAYLOAD_MODE`
- `VIDEO_RUNTIME_TIMEOUT_MS`

Current Hosting is live, but API deployment still needs a Firebase Functions
pass. The Firebase project currently has Cloud Functions API disabled; enable it
before deploying `/api/**` rewrites to a real backend.

## Runtime Facade Contract

Default submit request in `deploy-studio` mode:

```json
{
  "prompt": "A cinematic prompt",
  "settings": {
    "aspectRatio": "16:9",
    "durationSeconds": 4,
    "quality": "draft"
  },
  "inputAssetUrls": []
}
```

Accepted submit responses:

```json
{ "jobId": "..." }
```

or:

```json
{ "id": "..." }
```

Accepted status response:

```json
{
  "status": "running",
  "progress": 55,
  "message": "optional"
}
```

Status values are normalized into Video Lab states:

- `pending`, `queued` -> `queued`
- `starting`, `preparing` -> `preparing`
- `processing`, `running`, `generating` -> `generating`
- `uploading` -> `uploading`
- `succeeded`, `success`, `completed` -> `completed`
- `failed`, `error` -> `failed`
- `cancelled`, `canceled` -> `cancelled`

## Operations

- Pause submissions before runtime maintenance:
  `POST /v1/admin/runtime/pause`
- Resume only after `runtime-smoke.ts` passes.
- Keep a Lambda Labs spend guard outside this repo: stop idle GPU instances and
  alert if the host is reachable but `/health` fails.
- Rotate `VIDEO_RUNTIME_API_TOKEN` after anyone accesses the instance shell.
