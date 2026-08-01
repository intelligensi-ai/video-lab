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
6. Deploy Firebase Functions after enabling the Cloud Functions API on the
   Firebase project.

See `infra/lambda-labs/README.md` for the concrete runbook and templates.

Before public promotion, deploy the Firestore indexes, leave direct client access to API-managed records denied, verify a frozen dependency install, and complete the release gates in `public-runtime-readiness.md`. Existing deployments and production images remain digest-pinned; this repository does not mutate them.
