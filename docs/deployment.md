# Deployment

CI validates lint, typecheck, contract lint, tests, and builds. Deploy manually
to Firebase Hosting/Functions after configuring secrets and project ID. Use
GitHub environments for production secrets; do not auto-deploy every branch.

## Runtime Deployment

The Firebase-hosted app must call the GPU runtime through the Video Lab API, not
from the browser. For Deploy Studio running LTX Sulphur on a Lambda Labs
instance:

1. Provision the Lambda Labs GPU host and Deploy Studio runtime.
2. Expose Deploy Studio's authenticated stable runtime API over HTTPS; do not expose the worker origin to Video Lab or its browser clients.
3. Configure Video Lab with the server-only Intelligensi API key, `VIDEO_RUNTIME_PROVIDER=intelligensi-api`, `VIDEO_RUNTIME_BASE_URL=https://api.intelligensi.ai`, and `VIDEO_RUNTIME_ID=longform-ltx-storyboard-studio`.
4. Keep Deploy Studio's renewable runtime lease private to Deploy Studio. Direct Firestore/worker discovery is a migration fallback, not the production boundary.
5. Run `scripts/runtime-smoke.ts` through the versioned gateway before enabling user
   submissions.
6. Enable the Cloud Functions and Cloud Tasks APIs. Grant the deployed API
   service account only the task-enqueuer and task-invoker permissions required
   for the private `processVideoLabJobs` queue.
7. Deploy Firestore rules and indexes first, including the two
   `storyboardAsyncJobs` claim/recovery indexes.
8. Deploy both Firebase Functions (`api` and `processVideoLabJobs`), then Hosting.
   The browser must use only same-origin `/api` routes.
9. For controlled acceptance, configure a short-lived staging UID allow-list and
   policy version. Normal production defaults to Firestore-backed entitlements;
   an absent or invalid record fails closed.
10. Submit one Director job, refresh the page while it runs, and prove the same
    opaque job completes. Inspect the deployed bundle and browser network log to
    confirm no raw Cloud Run, Deploy Studio or worker origin appears.

See `infra/lambda-labs/README.md` for the concrete runbook and templates.

Before public promotion, leave direct client access to API-managed queue,
entitlement, rate-limit and media records denied, verify a frozen dependency
install, and complete the release gates in `public-runtime-readiness.md`.
Existing deployments and production images remain digest-pinned; this
repository does not mutate them.
