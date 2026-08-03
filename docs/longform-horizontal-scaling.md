# LongForm horizontal scaling in Video Lab

Video Lab keeps the durable owner-scoped queue and delegates GPU selection to Deploy Studio. It never accepts a worker, provider, region, image, priority, or upstream URL from the browser.

The internal queue dispatcher fills at most `VIDEO_LAB_WORKER_CONCURRENCY` slots (default two). Firestore/local queue claims remain atomic. The existing one-active-generation-per-user rule provides fair access across users. Deploy Studio then transactionally reserves one healthy GPU worker for each claimed generation.

When no GPU worker is ready, the Runtime API returns `runtime_capacity_pending`. Video Lab restores the generation to `queued`, keeps the user's active-generation lock, preserves prompts/frames, and displays “Preparing generation capacity”. It does not charge or report a failed render. Queue depth and oldest wait are reported to Deploy Studio through the authenticated server-to-server capacity endpoint.

Completed clips are canonical Video Lab artifacts. Each output has a server-generated private path, content type, byte length, and SHA-256. Assembly resolves only completed scene generations owned by the same user and project, then sends short-lived portable artifact manifests to the selected worker. The manifests are never persisted in public generation settings or returned to the browser.

Production settings:

```text
VIDEO_LAB_WORKER_CONCURRENCY=2
VIDEO_LAB_ASSEMBLY_SOURCE_MAX_BYTES=167772160
VIDEO_RUNTIME_PROVIDER=intelligensi-api
VIDEO_RUNTIME_ID=longform-ltx-storyboard-studio
```

Increasing `VIDEO_LAB_WORKER_CONCURRENCY` does not increase per-GPU concurrency. It only permits more independent Deploy Studio leases to work in parallel. Keep the value at or below the approved pool maximum until paid concurrency acceptance proves a larger setting.
