# Runtime adapter

`VideoRuntimeAdapter` defines health, submit, status, cancel, and output fetch
operations. `MockVideoRuntimeAdapter` supports local deterministic completion
and failure markers.

`SulphurLtxRuntimeAdapter` reads endpoint, auth, path, payload, and timeout
configuration from environment variables. In production it operates in
`intelligensi-api` mode against Deploy Studio's versioned contract. The API key
and gateway origin remain server-only. Provider-specific payload mapping stays
inside `packages/runtime-adapter` and never reaches browser contracts.

## Stable Deploy Studio API

The authoritative contract is
`Deploy Studio/docs/intelligensi-runtime-api.openapi.yaml`. Configure Video Lab
with:

```text
VIDEO_RUNTIME_PROVIDER=intelligensi-api
VIDEO_RUNTIME_BASE_URL=https://api.intelligensi.ai
VIDEO_RUNTIME_ID=longform-ltx-storyboard-studio
VIDEO_LAB_RUNTIME_API_KEY=<server-held Intelligensi API key>
VIDEO_RUNTIME_PAYLOAD_MODE=intelligensi-api
VIDEO_RUNTIME_AUTH_HEADER=X-Intelligensi-API-Key
VIDEO_RUNTIME_AUTH_SCHEME=none
```

The matching Deploy Studio secret is also `VIDEO_LAB_RUNTIME_API_KEY`. This is
a dedicated Video Lab service credential and must not be the Lambda Cloud
`LAMBDA_API_KEY` used for instance provisioning. `VIDEO_RUNTIME_API_TOKEN`
remains a backward-compatible alias only.

Video Lab calls only `/v1/runtimes/{runtimeId}/...`. Deploy Studio resolves and
validates the renewable runtime lease, authenticates the server caller,
normalizes worker-native jobs into the OpenAPI `Job` schema, and proxies media.
The browser sees only Video Lab's same-origin `/api/v1/...` routes.

Before marking the runtime connected, Video Lab asks the gateway for a ready
LongForm runtime with:

```text
GET /v1/runtimes?capability=storyboard-enhance&ready=true
```

The runtime id must match `VIDEO_RUNTIME_ID`.

Structured LongForm enhancement uses the same gateway and API key at
`/v1/runtimes/{runtimeId}/storyboards/enhance`. Exact shot cardinality and the
strict response schema are validated again in Video Lab. No paid LLM fallback
is used.

Runtime API v1.6 adds an allow-listed LongForm video-model contract. Projects
persist `videoModel` as either `ltx-2.3` or `ltx-2.5`; generation requests use
`video_model`, while Director requests use `videoModel` according to their
respective schemas. The gateway schedules only a worker whose sanitized model
capability and approved immutable image digest both match that selection.

LTX 2.3 remains the compatibility default. LTX 2.5 remains disabled in the UI
until health reports an approved ready Preview worker. Fresh projects with no
generated video may switch in place. Switching a project with draft or accepted
video creates a separate copy and preserves the source project and outputs. The
copy retains its prompts and frame anchors but removes old-model video IDs so
they cannot be accepted or assembled under the new model. The API also rejects
in-place model changes for rendered projects and requires the persisted project,
generation request and accepted assembly clips to have matching model provenance.
A dropdown value never selects an image, endpoint, model path or provider directly.

Job polling remains backward compatible with the original `status`, `progress`
and `message` fields. Runtime API v1.1 may also return `state`, `stage`,
`framesRendered`, `totalFrames`, `currentScene` and `totalScenes`; Video Lab
persists and displays these counters only when Deploy Studio returns them.

## Migration fallback

The older direct-worker handover uses the private Firestore document
`runtimeDiscovery/current`. It remains temporarily available for deployments
that have not adopted runtime API v1.1, but it is not the production target.
Deploy Studio publishes the active runtime origin, heartbeat, and a short
renewable lease; Video Lab rejects expired or malformed leases.

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

The private `/api/storyboards/enhance` route is also retained only as a migration
fallback. New deployments use the versioned runtime API route above.

The implementation brief for the Deploy Studio repository is
[`deploy-studio-runtime-handover-codex.md`](./deploy-studio-runtime-handover-codex.md).

For Deploy Studio on Lambda Labs, use
`infra/lambda-labs/video-lab-runtime.env.example` as the environment template
and `scripts/runtime-smoke.ts` as the pre-deploy connectivity check.
