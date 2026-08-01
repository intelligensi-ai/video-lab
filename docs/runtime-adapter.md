# Runtime adapter

`VideoRuntimeAdapter` defines health, submit, status, cancel, and output fetch
operations. `MockVideoRuntimeAdapter` supports local deterministic completion
and failure markers.

`SulphurLtxRuntimeAdapter` reads endpoint, auth, path, payload, and timeout
configuration from environment variables. Provider-specific payload mapping
stays inside `packages/runtime-adapter` and never reaches browser contracts.

## Automatic Deploy Studio handover

Production runtime discovery uses the private Firestore document
`runtimeDiscovery/current`. Deploy Studio publishes the active runtime origin,
instance identity, heartbeat, and a short renewable lease. The Video Lab API
polls this document, rejects expired or malformed leases, health-checks the
runtime, and switches adapters when Deploy Studio publishes a replacement.

The discovery document is denied to browser clients by Firestore rules. The
public runtime-status response contains only safe connection state and lease
metadata; it never returns the runtime origin or IP address.

Video Lab API options:

```text
VIDEO_RUNTIME_DISCOVERY_COLLECTION=runtimeDiscovery
VIDEO_RUNTIME_DISCOVERY_DOCUMENT=current
VIDEO_RUNTIME_DISCOVERY_REFRESH_MS=10000
```

`VIDEO_RUNTIME_BASE_URL` and the old `runtimeState/config` document are available
only as explicit server-side migration fallbacks. Production ignores both unless
`VIDEO_RUNTIME_ALLOW_ENV_FALLBACK=true`; normal deployments must use a valid,
unexpired Deploy Studio lease.

The adapter rejects redirects and refuses output URLs whose origin differs from
the configured runtime. Production runtime origins must be HTTPS, contain no path,
credentials, query or fragment, avoid private/link-local hosts, and match
`VIDEO_RUNTIME_ALLOWED_ORIGINS` when configured.

Storyboard enhancement is a separate server-only call to Deploy Studio's local
Gemma endpoint. Video Lab validates exact shot cardinality, order and the strict
response schema before returning suggestions to the browser. No paid LLM fallback
is used.

The implementation brief for the Deploy Studio repository is
[`deploy-studio-runtime-handover-codex.md`](./deploy-studio-runtime-handover-codex.md).

For Deploy Studio on Lambda Labs, use
`infra/lambda-labs/video-lab-runtime.env.example` as the environment template
and `scripts/runtime-smoke.ts` as the pre-deploy connectivity check.
