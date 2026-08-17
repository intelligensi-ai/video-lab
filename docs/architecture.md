# Architecture

Video Lab is OpenAPI-first. React and API tests use `contracts/video-lab.openapi.yaml`. The API exposes stable `/v1` resources and delegates runtime translation to `packages/runtime-adapter`.

Firebase Auth supplies identity. Firestore stores private storyboard projects, migration drafts, generations, durable queue/idempotency/active-job records, runtime leases and operational metadata. Cloud Storage stores private user uploads and outputs. Browser access to these operational records is denied; the authenticated Video Lab API enforces ownership and returns only public projections.

Deploy Studio remains the runtime lifecycle boundary. Its local Gemma enhancer and LongForm LTX worker are reached only by the Video Lab server using allow-listed origins and server-held credentials. See `public-runtime-readiness.md` for the full diagram and threat model.

The minimal creator's complete request, inference, quality, persistence and
release boundaries are maintained in
[`creator-minimal-launch-runbook-2026-08-17.md`](creator-minimal-launch-runbook-2026-08-17.md).
That runbook is authoritative for the Director contract, semantic-memory
limits, LTX 2.3/2.5 selection and generated-text enforcement; the OpenAPI
documents remain authoritative for wire schemas.
