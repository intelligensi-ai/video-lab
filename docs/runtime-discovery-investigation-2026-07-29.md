# VideoLab Runtime Discovery Investigation

Date: 2026-07-29

## Summary

VideoLab is not discovering the current Deploy Studio LongForm Lambda runtime because the Firebase handover documents still publish the stale instance:

```text
baseUrl: http://209.20.158.84
instanceId: d1edafb920234a48be57608658c7007a
status: error
```

They do not contain the current Deploy Studio runtime:

```text
session: lambda-1785356137162-sgvaas
baseUrl: http://209.20.158.13
instanceId: 9c643a3b50ff4d36bfd314e0ed618791
status: ready
```

No production writes were made during the investigation.

## Code Path

VideoLab reads Deploy Studio discovery in:

```text
apps/api/src/index.ts
```

The main function is:

```ts
loadRuntimeDiscovery()
```

It reads Firestore using:

```ts
firestore
  .collection(process.env.VIDEO_RUNTIME_DISCOVERY_COLLECTION ?? "runtimeDiscovery")
  .doc(process.env.VIDEO_RUNTIME_DISCOVERY_DOCUMENT ?? "current")
  .get()
```

With the deployed defaults, that means:

```text
project: intelligensi-ai-site
collection: runtimeDiscovery
document: current
```

The Admin UI calls these API routes:

```text
GET  /v1/runtime/status
POST /v1/admin/runtime/discover
POST /v1/admin/runtime/connect
```

The Admin UI implementation is in:

```text
apps/web/src/main.tsx
```

## Live Firebase Documents

Read-only inspection found:

```text
runtimeDiscovery/current
baseUrl: http://209.20.158.84
status: error
instanceId: d1edafb920234a48be57608658c7007a
worker: longform-ltx-storyboard-studio
```

And:

```text
runtimeDiscovery/longform-ltx-storyboard-studio
baseUrl: http://209.20.158.84
status: error
runtimeId: longform-ltx-storyboard-studio
instanceId: d1edafb920234a48be57608658c7007a
```

Both documents are stale relative to the current Deploy Studio runtime.

## Why `209.20.158.84:7860` Appears

This value is hardcoded only as the Admin manual fallback input default:

```ts
const [manualRuntimeOrigin, setManualRuntimeOrigin] =
  useState("http://209.20.158.84:7860");
```

File:

```text
apps/web/src/main.tsx
```

It is not coming from Firebase discovery. Firebase currently has:

```text
http://209.20.158.84
```

without `:7860`.

## Gateway vs Direct Runtime

VideoLab expects to call the runtime directly, not through Deploy Studio gateway routes.

The runtime adapter uses these direct endpoints:

```text
GET  /health
POST /preview
GET  /jobs/{jobId}
POST /jobs/{jobId}/cancel
GET  /jobs/{jobId}/output
POST /prompt/complete
```

There is no VideoLab code for these gateway routes:

```text
/v1/runtimes/longform-ltx-storyboard-studio
/v1/runtimes/longform-ltx-storyboard-studio/health
/v1/runtimes/longform-ltx-storyboard-studio/preview
```

## Port and Protocol Handling

VideoLab is not hardcoded to port `7860` in the API.

The API accepts both `http` and `https` origins:

```ts
if (!["http:", "https:"].includes(url.protocol)) return undefined;
```

It does not reject port 80 or HTTP origins.

The stale `:7860` value is only the Admin input default. The old Lambda host health check worked on port 80:

```text
http://209.20.158.84/health      -> healthy
http://209.20.158.84:7860/health -> timeout
```

## Config and Environment Keys

The deployed function environment includes:

```text
VIDEO_RUNTIME_BASE_URL=http://129.213.18.165
VIDEO_RUNTIME_PAYLOAD_MODE=deploy-studio
VIDEO_RUNTIME_PROVIDER=sulphur-ltx
VIDEO_RUNTIME_API_TOKEN=
ADMIN_EMAILS=develop@intelligensi.ai
```

Discovery-specific env keys are not set, so defaults are used:

```text
VIDEO_RUNTIME_DISCOVERY_COLLECTION -> runtimeDiscovery
VIDEO_RUNTIME_DISCOVERY_DOCUMENT   -> current
VIDEO_RUNTIME_DISCOVERY_REFRESH_MS -> 10000
```

Because `runtimeDiscovery/current` exists, VideoLab does not fall back to `VIDEO_RUNTIME_BASE_URL`. It only falls back if the discovery document is missing.

## Caching

VideoLab has only short in-memory API caching:

```text
VIDEO_RUNTIME_DISCOVERY_REFRESH_MS default: 10000ms
```

It does not persist or cache the old Lambda origin itself.

Manual connect stores a runtime URL in memory only for the current function instance. However, `loadRuntimeDiscovery()` can overwrite or clear it again when it rereads a non-ready Deploy Studio document.

The stale source is Firestore/Deploy Studio publishing stale documents.

## Likely Reason

Deploy Studio's publisher is still writing `status: error` for the old instance:

```text
d1edafb920234a48be57608658c7007a
http://209.20.158.84
```

It is not replacing either document:

```text
runtimeDiscovery/current
runtimeDiscovery/longform-ltx-storyboard-studio
```

with the new live runtime:

```text
lambda-1785356137162-sgvaas
9c643a3b50ff4d36bfd314e0ed618791
http://209.20.158.13
```

## Safest Minimal Fix

Fix the Deploy Studio publisher so every new LongForm runtime startup writes or overwrites:

```text
runtimeDiscovery/current
runtimeDiscovery/longform-ltx-storyboard-studio
```

with a ready lease for the current runtime:

```json
{
  "source": "deploy-studio",
  "status": "ready",
  "baseUrl": "http://209.20.158.13",
  "instanceId": "9c643a3b50ff4d36bfd314e0ed618791",
  "worker": "longform-ltx-storyboard-studio",
  "runtimeId": "longform-ltx-storyboard-studio",
  "leaseExpiresAt": "future timestamp",
  "heartbeatAt": "server timestamp",
  "updatedAt": "server timestamp"
}
```

VideoLab-side minimal cleanup later: remove the hardcoded manual default `http://209.20.158.84:7860`, or default it to blank/current expected origin.

## Read-Only Inspection Commands

Inspect `runtimeDiscovery/current`:

```bash
curl -sS \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/intelligensi-ai-site/databases/(default)/documents/runtimeDiscovery/current"
```

Inspect `runtimeDiscovery/longform-ltx-storyboard-studio`:

```bash
curl -sS \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/intelligensi-ai-site/databases/(default)/documents/runtimeDiscovery/longform-ltx-storyboard-studio"
```

List all discovery documents:

```bash
curl -sS \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/intelligensi-ai-site/databases/(default)/documents/runtimeDiscovery"
```

Inspect deployed function environment:

```bash
gcloud functions describe api \
  --gen2 \
  --region us-central1 \
  --project intelligensi-ai-site \
  --format="json(serviceConfig.environmentVariables)"
```
