# Runtime adapter

`VideoRuntimeAdapter` defines health, submit, status, cancel, and output fetch
operations. `MockVideoRuntimeAdapter` supports local deterministic completion
and failure markers.

`SulphurLtxRuntimeAdapter` reads endpoint, auth, path, payload, and timeout
configuration from environment variables. Provider-specific payload mapping
stays inside `packages/runtime-adapter` and never reaches browser contracts.

For Deploy Studio on Lambda Labs, use
`infra/lambda-labs/video-lab-runtime.env.example` as the environment template
and `scripts/runtime-smoke.ts` as the pre-deploy connectivity check.
