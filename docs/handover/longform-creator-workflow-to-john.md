# Video Lab creator workflow: production-platform handover to John

Status: **prepared but not ready to hand over; CWA7R exposed failed end-anchor adherence in A9, and the repaired successor workflow still requires an immutable build and paid proof**

This document is the factual handover reference for the production-platform
work that begins after the creator-to-generation path has passed paid
acceptance. It deliberately separates the accepted generation system from the
Firebase, financial, operational, and public-rollout work owned by John.

Do not interpret this document as production approval. Sections marked
`PENDING SUCCESSOR ACCEPTANCE` must be replaced with direct evidence from a guarded paid run
before the handover is declared ready.

## 1. Handover baseline

| Component | Revision or identity | Status |
| --- | --- | --- |
| LongForm A9 image | `sha256:11f4fdb1a603af4ebd7eea6ed2cc71fa081f730cb6fbe2dab8a32997803e77f8` | Immutable candidate; valid media generation passed, end-anchor adherence failed, not promoted |
| LongForm A9 source | `64d726e9d397b6db3f394178a0003010eb4ffc91` | Contains the non-root diagnostics repair proved by CWA7 |
| Instruction bundle | `2026-08-10.1` | Proved through real A9 Gemma inference |
| A9 workflow schema | `ltx23-reference-temporal-v3` | Produced a valid video but failed the encoded end-anchor check |
| Prepared successor schema | `ltx23-reference-temporal-v4` | Local guide-aware draft repair; not built or paid-tested |
| Deploy Studio acceptance harness | `1f129faf61326869bd7656bfe4a223d86b486ec7` | CWA7R-tested; endpoint, restart-timeout and transient-shutdown repairs are local and uncommitted |
| Video Lab | `c880ff92fbdfc5dbe7388bbb9f15e74c6c90c3f3` | CWA7R-tested |
| Deploy Studio branch | `codex/longform-gemma4-multimodal-hardening` | Do not merge merely because this handover exists |
| Video Lab branch | `codex/longform-gemma4-multimodal-hardening` | Do not merge merely because this handover exists |
| Production LongForm pin | Unchanged by this work | Promotion remains a separate approval |

Gate CWA7R proved A9 startup, CUDA, ComfyUI and model readiness, runtime
authentication, real strict Gemma output, all four original anchor frames,
independent first/last-frame regeneration, failed-replacement preservation,
two-user queue and cancellation boundaries, one real LTX output, corrected
media validation, completed-generation idempotency replay, accepted-video
project persistence, stale-video signalling and same-origin private delivery.
The MP4 is valid silent H.264 at 1024x576, 24 fps and two seconds, with no
sustained black or frozen segment.

It did **not** prove start/end anchoring. The encoded first frame followed the
accepted start anchor with SSIM `0.617031`, but the encoded final frame changed
to an unrelated third-person composition and scored only `0.117263` against
the accepted end anchor. That fails the deliberately lenient `0.25`
missing-anchor threshold. Do not describe A9 as an accepted anchored runtime.

CWA7R then stopped at a 12-minute restart-readiness assertion. The same A9
runtime required approximately 12 minutes 44 seconds to reach full readiness
earlier in the run. Redacted restart diagnostics showed healthy CUDA, a
verified cache with zero downloads, and ComfyUI reaching `Starting server`;
they did not show a runtime or media failure. The harness now allows 16 minutes
and Deploy Studio's shutdown reconciliation tolerates bounded transient Lambda
inventory failures. The endpoint failure requires a runtime workflow change,
so A9 cannot be reused for final acceptance. The local successor decodes the
guide-aware first pass, declares schema `ltx23-reference-temporal-v4`, uses full
end-frame strength, and fails paid acceptance unless both encoded endpoints
meet the bounded SSIM check. It must be built as a new immutable candidate and
paid-tested before this package is handed to John. Legal and licensing approval
remain outside this technical handover.

## 2. Acceptance evidence

### CPU-safe evidence already complete

- Deploy Studio: 84 selected tests pass, TypeScript lint passes, and the
  production build passes.
- LongForm runtime: 93 Python tests pass, including cold-timeout recovery,
  cancellation fencing, malformed configuration, cache and media-stack tests.
- Video Lab: 143 tests pass, typecheck passes, OpenAPI generation and 6
  contract checks pass, and the production build passes.
- Video Lab Playwright: 7/7 desktop/mobile tests pass.
- The minimal interface restores the accepted completed clip and download
  action after reopening and reloading a project.
- The paid harness covers exact Director cardinality, all four two-scene anchor
  frames, independent first- and last-frame regeneration, failed-replacement
  preservation, encoded endpoint adherence, silent-audio inspection, cancellation,
  idempotency, restart recovery, two development identities, and live browser
  redaction checks.
- CWA5 used one H100 PCIe in `us-west-3` with the existing persistent cache.
  The owned worker was terminated and Lambda independently reported zero active
  instances after the failed gateway phase.
- CWA6A used one H100 SXM in `us-south-3`. It failed closed at the provider
  CUDA-fabric boundary before model inference. The worker was terminated,
  Lambda independently reported zero active instances, approximate GPU compute
  was USD `$1.91`, and A8 remained unpromoted.
- CWA6B used one H100 PCIe in `us-west-3`. The runtime became fully ready;
  Gemma, anchor frames, independent regeneration, preservation, ownership and
  cancellation checks passed. Anchored LTX was blocked before inference by a
  missing writable `/app/diagnostics` image directory. The worker was
  terminated, Lambda independently reported zero active instances, approximate
  GPU compute was USD `$2.08`, and A8 remained unpromoted.
- CWA7 used one H100 PCIe in `us-west-3` against immutable A9. Real Gemma,
  Director probes, four anchors, two independent replacement anchors,
  preservation, deterministic FIFO, active-user limiting, cross-user denial,
  queued cancellation and one anchored LTX render passed. The harness then
  stopped on a local `pix_th`/`pic_th` false positive before restart and browser
  acceptance. The worker was terminated, Lambda independently reported zero
  active instances, approximate GPU compute was USD `$2.08`, and A9 remained
  unpromoted.
- CWA7R reused immutable A9 on one H100 PCIe in `us-west-3`. Real Gemma and
  anchor smoke, corrected LTX validation, completed-generation idempotency,
  accepted-video persistence, stale signalling, same-origin private delivery,
  two-user isolation, fairness, cancellation and retry all passed. The valid
  silent MP4 is H.264 at 1024x576, 24 fps and two seconds, with no sustained
  black or frozen segment. Visual/SSIM inspection then proved its encoded last
  frame did not follow the accepted end anchor (`0.117263`, below `0.25`), so
  anchored LTX acceptance failed. Restart recovery reached healthy CUDA, verified the
  model cache with zero downloads and reached ComfyUI server startup, but the
  harness timed out at 12 minutes before A9's observed 12m44s readiness. The
  worker was terminated, a separate Lambda inventory returned zero instances,
  approximate GPU compute was USD `$3.14`, and A9 remained unpromoted. The
  guide-aware workflow, endpoint acceptance, restart window and transient
  shutdown reconciliation are repaired locally. A new immutable build and one
  bounded paid acceptance remain.
- A supplemental in-app Browser sanity check passed the local minimal workflow
  at 1440x900 and 390x844. This proves responsive rendering only; it does not
  replace the pending live paid runtime browser check. On mobile, the primary
  navigation remains horizontally scrollable and should receive final polish,
  while Director, settings, preview, generate and download controls remain
  available in the vertical flow.

### Narrow successor evidence required before handover

`PENDING SUCCESSOR ACCEPTANCE`:

- Run identifier and timestamps.
- Exact Deploy Studio and Video Lab commits tested.
- Provider instance type, region, and quoted rate.
- Launch, image-pull, container, Gemma, Z-Image, and LTX readiness timings.
- Gemma two- and five-scene results and targeted Scene 2 result: passed on A9
  in CWA7R; repeat only a bounded smoke probe if required to recreate inputs.
- Four original anchors, two independent replacement anchors, and
  failed-replacement preservation: passed on A9 in CWA7R; repeat only a bounded
  smoke probe if required to recreate inputs.
- One valid MP4, corrected `ffprobe`/black/freeze evidence, silent stream
  layout, two-user queue fairness, cross-user denial, queued cancellation and
  repeated cancellation: passed on A9 in CWA7R. End-anchor adherence failed and
  must pass on the successor digest.
- Completed-generation idempotency replay, accepted-video project persistence,
  project reopen and stale-video signalling: passed on A9 in CWA7R.
- Byte-identical completed-job and media recovery after runtime restart.
- Real minimal desktop/mobile and advanced Director browser screenshots.
- Browser request-origin inventory and infrastructure-redaction result.
- Actual compute time and approximate cost.
- Provider termination, cleared routes/leases, and zero unexpected instances.

The canonical sanitized result must live under
`E:\tmp\intelligensi-longform-creator-acceptance`; do not commit generated
media, runtime addresses, tokens, raw prompts, or test identities.

## 3. Responsibility boundary

```text
User browser
  -> Firebase Hosting at the Video Lab origin
  -> authenticated Video Lab API (/api/v1/...)
  -> owner-authorised project / asset / generation boundary
  -> durable Firestore queue and idempotency records
  -> server-held Deploy Studio Runtime API credential
  -> Deploy Studio runtime discovery, lease, scheduling and lifecycle
  -> immutable LongForm worker (Gemma -> Z-Image -> LTX)
  -> private Cloud Storage output
  -> authenticated Video Lab download route
  -> browser-owned blob URL for playback/download
```

Video Lab owns the creator interface, authentication boundary, projects,
prompts, references, jobs, version relationships, private media delivery, and
safe user-facing states.

Deploy Studio owns immutable runtime images, allow-listed runtime discovery,
GPU leases, provider lifecycle, readiness, cache configuration, fencing,
self-healing, shutdown, and provider reconciliation.

The LongForm worker owns local Gemma Director inference, frame generation, LTX
generation, capability reporting, job execution, cancellation, and runtime
artifact persistence. It does not decide identity, entitlement, billing, or
provider lifecycle.

## 4. Stable contracts

Authoritative public contract:

- `contracts/video-lab.openapi.yaml`

Authoritative Deploy Studio runtime contract:

- `Deploy Studio/Intelligensi.ai-Deploy-Studio/docs/intelligensi-runtime-api.openapi.yaml`

Public browser operations remain on the Video Lab origin. Important route
families include:

- `/api/v1/storyboards/projects`
- `/api/v1/storyboards/enhance`
- `/api/v1/director/proposals`
- `/api/v1/assets/...`
- `/api/v1/generations`
- `/api/v1/generations/{id}`
- `/api/v1/generations/{id}/cancel`
- `/api/v1/generations/{id}/download`
- `/api/v1/gallery`
- `/api/v1/runtime/status`

The browser must never receive the resolved runtime origin, provider address,
runtime token, private object path, runtime job identifier, provider instance
identifier, registry credential, SSH detail, or raw upstream stack trace.

## 5. Persistence and ownership contract

The following records are API-managed. Browser Firestore access is denied by
`firestore.rules`; the API resolves every identifier against the authenticated
UID.

| Collection | Purpose and essential ownership rule |
| --- | --- |
| `users/{uid}` | User projection. A user may read their own safe profile; roles remain server-controlled. |
| `storyboardProjects/{id}` | `{id, uid, title, form, createdAt, updatedAt}`. Every read/update/delete requires matching `uid`. |
| `storyboardDrafts/{uid}` | Legacy/private draft migration state. Server-only. |
| `storyboardDirectorProposals/{id}` | Owner-scoped proposal, target, patch, status, and audit metadata. |
| `assets/{id}` | Owner, purpose, content type, expected size, private object path, upload state, and normalized media evidence. |
| `generations/{id}` | Public generation fields plus server-only `uid`, runtime job, reference snapshot, object path, content type, and SHA-256. |
| `generationQueue/{generationId}` | Durable FIFO claim state: UID, status, attempt, timestamps, worker, and lease. |
| `generationIdempotency/{id}` | UID plus idempotency key mapping to one generation, with bounded expiry. |
| `generationActive/{uid}` | At most one active generation per user. Must be updated transactionally. |
| `runtimeState/queueMetrics` | Server-only outstanding count and operational queue state. |
| `runtimeDiscovery/{id}` | Server-only Deploy Studio runtime lease/discovery record. |
| `creditWallets/{uid}` | Server-owned available/reserved/spent balances. Never trust browser balances. |
| `creditLedger/{id}` | Append-only reserve, charge, release, and refund entries. |
| `projectDeletionQueue/{id}` | Durable, retryable cascading deletion request. |
| `adminAudit/{id}` | Safe administrator action record without secrets/private prompts. |
| `systemMetrics/{id}` | Server-only aggregate operational metrics. |

Private storage paths are server-derived:

- Uploads: `users/{uid}/uploads/...`
- Outputs: `users/{uid}/outputs/{generationId}.{extension}`

The browser does not choose these paths. Completed media is returned through
the authenticated `/api/v1/generations/{id}/download` route with
`Cache-Control: private,no-store` and a validated content type.

Current required indexes are versioned in `firestore.indexes.json`:

- `generations`: `uid ASC`, `createdAt DESC`
- `generationQueue`: `status ASC`, `createdAt ASC`
- `generationQueue`: `status ASC`, `leaseExpiresAt ASC`
- `storyboardDirectorProposals`: `uid ASC`, `projectId ASC`, `createdAt DESC`

John must validate the deployed indexes and rules against the Firebase
emulators and the staging project rather than assuming file presence proves
deployment.

## 6. Idempotency, queue, and recovery invariants

- A client supplies an opaque idempotency key; the server binds it to the
  authenticated UID and normalized operation.
- A replay returns the original generation. It must not reserve credit, enqueue
  another job, or trigger another runtime submission.
- `generationQueue`, `generationIdempotency`, `generationActive`, and queue
  metrics are created transactionally.
- One user has at most one active generation by default.
- Queue claims are leased and reclaimable. A stale claim must be reconciled
  against the runtime before retrying.
- A capacity miss returns work to the durable queue; it does not create a new
  generation.
- Cancellation is owner-only and repeatable.
- Successful frames and clips remain immutable versions. Replacement failure
  must not remove them.
- Runtime/provider errors must release or refund reservations exactly once.
- Runtime restart must reconnect to the existing job/output instead of
  resubmitting paid work.

## 7. Server configuration contract

Supply values through managed server secrets or environment configuration.
Never put secret values in Git, Hosting variables, browser bundles, or shared
runtime storage.

Runtime and gateway:

```text
VIDEO_RUNTIME_PROVIDER
VIDEO_RUNTIME_BASE_URL
VIDEO_LAB_RUNTIME_API_KEY
VIDEO_RUNTIME_ID
VIDEO_RUNTIME_MAX_CONCURRENCY
VIDEO_RUNTIME_PAYLOAD_MODE
VIDEO_RUNTIME_ALLOWED_ORIGINS
VIDEO_RUNTIME_ALLOW_ENV_FALLBACK
VIDEO_RUNTIME_DISCOVERY_COLLECTION
VIDEO_RUNTIME_DISCOVERY_DOCUMENT
VIDEO_RUNTIME_DISCOVERY_REFRESH_MS
VIDEO_RUNTIME_JOB_TIMEOUT_MS
VIDEO_RUNTIME_GLOBAL_QUEUE_LIMIT
VIDEO_LAB_WORKER_CONCURRENCY
VIDEO_LAB_WORKER_TOKEN
VIDEO_DEPLOY_STUDIO_BASE_URL
VIDEO_DEPLOY_STUDIO_API_TOKEN
VIDEO_DEPLOY_STUDIO_STORYBOARD_ENHANCE_PATH
VIDEO_STORYBOARD_ENHANCER_PROVIDER
VIDEO_STORYBOARD_ENHANCER_TIMEOUT_MS
```

API safety and financial boundary:

```text
VIDEO_LAB_ALLOWED_ORIGINS
VIDEO_LAB_RATE_LIMIT_PER_MINUTE
VIDEO_LAB_JSON_LIMIT
VIDEO_LAB_ASSEMBLY_SOURCE_MAX_BYTES
VIDEO_LAB_ASSEMBLY_RECOVERY_ATTEMPTS
ADMIN_EMAILS
FREE_TRIAL_CREDITS
CREDIT_LIMITS_ENABLED
GENERATION_BASE_COST
```

Frontend Firebase configuration may use the standard public Firebase web
configuration. Production must set `VIDEO_LAB_LOCAL_AUTH=false`/unset and must
not enable emulator or demo API modes.

## 8. Existing controls John must preserve

- Firebase bearer tokens are verified server-side in production.
- Local deterministic bearer identities are ignored in production.
- API-managed Firestore records are denied to direct browser access.
- Upload type, size, declared content type, decoded media, dimensions, and
  ownership are validated before runtime use.
- Runtime origins are HTTPS, origin-only, and allow-listed.
- Runtime redirects and arbitrary upstream URLs are rejected.
- Same-origin download responses expose safe public projections only.
- CSP, frame denial, no-sniff, strict referrer, and permissions headers are
  configured in `firebase.json`.
- Safe problem responses use classifications and correlation IDs rather than
  raw provider errors.
- Pause, resume, kill switch, and worker-token boundaries already exist.
- The current in-process request limiter is a defence-in-depth fallback, not a
  production distributed limit.

## 9. Work owned by John

### Firebase identity and session productionisation

- Configure the correct production Firebase project and Hosting target.
- Enable intended sign-in providers and account recovery.
- Verify token refresh, revocation, disabled accounts, logout, and session
  expiry through Hosting/Functions.
- Establish server-controlled administrator roles/custom claims.
- Add Firebase App Check if it fits the selected clients, while keeping real
  authentication and authorization authoritative.
- Run two-browser staging IDOR tests with real Firebase identities.

### Firestore and Storage deployment

- Deploy and verify rules and indexes.
- Prove that users cannot read API-managed documents directly.
- Prove that output access is owner-only and that upload writes can only occur
  through the API-mediated upload boundary.
- Configure backups, restore testing, point-in-time recovery where selected,
  and least-privilege service accounts.

### Distributed rate and concurrency limits

- Replace process-local-only enforcement with a shared atomic limiter suitable
  for multiple Functions instances.
- Define limits for sign-in-sensitive routes, Director requests, uploads,
  generation submissions, polling, cancellation, downloads, and administrator
  operations.
- Enforce per-user, per-workspace, and global generation limits server-side.
- Preserve the durable queue's fairness and the one-active-generation
  invariant unless an explicit paid plan changes it.
- Return safe `429` responses with bounded retry guidance.

### Entitlements, wallet, and financial controls

- Implement a server-owned entitlement interface. The browser may never assert
  that it is entitled or has funds.
- Reserve estimated credit in the same transactional boundary as durable job
  creation.
- Charge once on successful finalization; release/refund once on cancellation,
  terminal failure, or provider loss.
- Keep the ledger append-only and every operation idempotent.
- Add per-operation, per-user, per-day, and global spend ceilings.
- Prevent retries, lease recovery, and ambiguous provider responses from
  producing duplicate charge or generation.
- Keep the payment provider separate from the LongForm worker and Deploy
  Studio runtime.

### Storage policy

- Decide product quotas for uploads, frame versions, draft candidates, videos,
  and total project storage.
- Define temporary-upload expiry, failed-artifact cleanup, user-visible
  retention, account deletion, legal hold if required, and backup retention.
- Implement durable, idempotent cascading deletion and verify object absence.
- Alert before quota exhaustion; do not silently delete accepted work.

### Monitoring and incident response

- Emit structured logs with safe request, project, generation, lease, and
  provider correlation identifiers.
- Never log credentials, complete private prompts, media, raw runtime errors,
  or runtime origins in user-visible telemetry.
- Instrument auth failures, queue depth/age, claim recovery, generation stage
  duration, runtime readiness, cache hit/miss, cancellation, output upload,
  idempotent replay, credit reservation/finalization, and provider cleanup.
- Alert on stuck leases, old queued jobs, error-rate changes, duplicate-charge
  invariants, storage failures, runtime unavailability, missing shutdown, and
  unexpected active provider instances.
- Document pause, kill, rollback, credential rotation, and incident recovery.

### Production rollout

- Deploy to staging first with immutable source and runtime identifiers.
- Run auth, rules, IDOR, rate-limit, entitlement, quota, monitoring, rollback,
  and kill-switch acceptance.
- Do not rerun expensive Gemma/Z-Image/LTX inference unless the runtime,
  gateway, generation payload, media path, or ownership boundary changed.
- If only Firebase identity/rules/financial wrappers changed, use controlled
  stored artifacts and mock runtime jobs for most staging tests, followed by at
  most one approved bounded real smoke when the changed boundary requires it.
- Require explicit production approval before changing the runtime digest,
  Firebase production deployment, DNS, payment activation, or public access.
- Retain the previous deployable application revision and runtime digest for
  rollback. Test the kill switch before public launch.

## 10. John completion evidence

John's platform work is complete only with direct staging evidence for:

1. Two real Firebase identities and session expiry/revocation.
2. Project, proposal, job, asset, media, and cancellation IDOR denial.
3. Direct Firestore/Storage access denial for API-managed records.
4. Distributed limits across at least two Functions instances.
5. Atomic entitlement/credit reserve, charge, release, refund, and replay.
6. No duplicate job or charge after retry, timeout, lease expiry, or ambiguous
   provider response.
7. Storage quota enforcement and completed deletion/cleanup.
8. Queue and generation alerts reaching an accountable destination.
9. Pause, emergency kill, runtime rollback, and application rollback.
10. Desktop/mobile staging workflow with accessible loading/error states.
11. Browser network and built-bundle inspection showing no runtime secrets or
    infrastructure.
12. A final provider inventory with zero unexpected active instances.

## 11. Explicit non-goals for John

Unless a failed acceptance item proves a boundary defect, do not change:

- Gemma model or Director instruction bundle.
- Z-Image or LTX workflow/model files.
- Scene cardinality or prompt schemas.
- Frame/version preservation semantics.
- The eventual immutable, fully accepted successor digest.
- Deploy Studio's role as the lifecycle boundary.
- MiniMax, Bonsai, or another model integration.

Do not mark the public launch complete merely because rules, dashboards, or
payment UI exist. Require the staging evidence in Section 10.
