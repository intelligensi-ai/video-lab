# Deployment

CI validates lint, typecheck, contract lint, tests, and builds. Deploy manually
to Firebase Hosting/Functions after configuring secrets and project ID. Use
GitHub environments for production secrets; do not auto-deploy every branch.

## Runtime Deployment

The Firebase-hosted app must call the GPU runtime through the Video Lab API, not
from the browser. For Deploy Studio running LTX Sulphur on a Lambda Labs
instance:

1. Provision the Lambda Labs GPU host and Deploy Studio runtime.
2. Put an HTTPS/authenticated facade in front of the local runtime port.
3. Configure the API with `VIDEO_RUNTIME_PROVIDER=sulphur-ltx` plus the runtime
   endpoint, paths, and token.
4. Run `scripts/runtime-smoke.ts` against the endpoint before enabling user
   submissions.
5. Deploy Firebase Functions after enabling the Cloud Functions API on the
   Firebase project.

See `infra/lambda-labs/README.md` for the concrete runbook and templates.
