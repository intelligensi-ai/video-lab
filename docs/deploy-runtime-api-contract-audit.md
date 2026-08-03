# Deploy Studio runtime API contract audit

Date: 2026-08-01

Authoritative source:
`Deploy Studio/docs/intelligensi-runtime-api.openapi.yaml`, version 1.1.0.

## Result

Video Lab now targets Deploy Studio's stable authenticated runtime API rather
than treating the current Lambda worker origin or Firestore lease as its
production integration contract.

```text
Browser
  -> Video Lab /api/v1 routes and Firebase identity
  -> Video Lab server-held X-Intelligensi-API-Key
  -> https://api.intelligensi.ai/v1/runtimes/{runtimeId}/...
  -> Deploy Studio private renewable lease
  -> current LongForm worker
```

The browser never receives the Deploy Studio API key, Lambda hostname, worker
origin, lease document, provider identifier, runtime token, runtime job ID, or
private output path.

The service credential is configured as `VIDEO_LAB_RUNTIME_API_KEY` in Deploy
Studio and `VIDEO_RUNTIME_API_TOKEN` in Video Lab. It is distinct from the
Lambda Cloud API key used to create or terminate provider instances.

## Drift found and repaired

| Area | Previous behaviour | Contract-aligned behaviour |
|---|---|---|
| Runtime discovery | Video Lab read the private Firestore lease and connected directly to the worker | Deploy Studio resolves its private lease behind the stable gateway |
| Authentication | Video Lab used a worker bearer token | Video Lab uses a server-only `X-Intelligensi-API-Key`; the gateway uses its separate worker credential |
| Preview submission | Video Lab called worker `/jobs` | Video Lab calls `/v1/runtimes/{runtimeId}/preview` |
| Job state | Worker-native statuses, timestamps, links and 0-100 progress leaked across the internal boundary | Gateway returns the OpenAPI `Job` schema, stable links, ISO timestamps, standard statuses and 0-1 progress |
| Health | Raw worker health was returned | Gateway returns `RuntimeHealth` plus a safe LongForm feature projection |
| Prompt completion | Worker-specific response names were accepted | Gateway returns `PromptCompletionResponse`; Video Lab supports the contract `completion` field |
| Storyboard enhancement | Video Lab depended on private `/api/storyboards/enhance` | Runtime API v1.1 defines `/v1/runtimes/{runtimeId}/storyboards/enhance` with strict request and response schemas |
| Output | Direct worker output and private-path fallback were possible | Contract mode downloads through the stable gateway output route only |
| Upstream errors | Raw worker response text could enter adapter errors | Gateway returns bounded `application/problem+json` classifications |

## Contract operation matrix

| Operation | Video Lab server use | Browser exposure |
|---|---|---|
| `GET /v1/runtimes` | Deployment diagnostics and future catalogue use | None |
| `GET /v1/runtimes/{runtimeId}` | Runtime metadata | Safe Video Lab status projection only |
| `GET /v1/runtimes/{runtimeId}/health` | Readiness and supported LongForm controls | Safe capability booleans only |
| `POST /v1/runtimes/{runtimeId}/preview` | Frame, scene, project and assembly submission | Opaque Video Lab generation ID only |
| `GET /v1/runtimes/{runtimeId}/jobs/{jobId}` | Worker polling | Video Lab-owned status and progress only |
| `POST .../jobs/{jobId}/cancel` | Cancellation | Video Lab same-origin cancel action |
| `GET .../jobs/{jobId}/output` | Server-side media ingestion | Owner-authorized Video Lab media route |
| `POST .../prompt/complete` | Simple prompt completion | Sanitized completed prompt |
| `POST .../storyboards/enhance` | Structured local Gemma enhancement | Schema-validated suggestions |

## Compatibility policy

- Runtime API v1.1 is a backwards-compatible addition to v1.0.
- Existing worker paths and Video Lab's direct-worker adapter remain available
  only as an explicit migration fallback.
- New production configuration must use
  `VIDEO_RUNTIME_PROVIDER=intelligensi-api`.
- Existing jobs and deployments stay pinned; adopting the gateway does not
  mutate a running worker or production image.
- Contract-breaking changes require a new API version rather than silently
  changing `/v1` response shapes.
- Video Lab has a cross-repository contract test when the Deploy Studio sibling
  repository is present. Release automation should check out both repositories
  or publish the OpenAPI file as a versioned contract artifact.

## Validation completed without local inference

- Deploy Studio TypeScript compilation and production build.
- Deploy Studio regression suite: 67/67 tests passed.
- OpenAPI 3.1 validation of the authoritative contract.
- Video Lab lint, TypeScript checks and production workspace build.
- Video Lab regression suite: 68/68 tests passed, including adapter, enhancer
  and cross-repository contract coverage.

No LTX, Gemma, Docker, CUDA, frame generation or video generation ran on the
local workstation.

## Paid-runtime acceptance still required

The approved paid-runtime test must exercise this exact path, not a worker URL:

1. Authenticate Video Lab's server to the stable gateway.
2. Verify public health and protected catalogue metadata.
3. Enhance a multi-shot storyboard through the versioned enhancer endpoint.
4. Submit first-frame, last-frame, scene and project jobs through `/preview`.
5. Confirm status normalization, cancellation and stable links.
6. Download media through the gateway and then Video Lab's owner-authorized
   same-origin route.
7. Restart or replace the worker and prove that Video Lab keeps using the same
   gateway origin.
8. Confirm the browser contains no gateway key, worker URL, lease data or
   provider details.
9. Exercise automatic shutdown and independently confirm zero active Lambda
   instances.

## 2026-08-03 follow-up security audit

The first production-audit pass found that the internal runtime-discovery
object still carried `baseUrl` into the public `RuntimeStatus` projection. The
OpenAPI schema did not advertise the field, but JavaScript response spreading
made the raw origin observable to authenticated users and allowed the admin UI
to read it back.

The public projection now explicitly removes the internal origin. The shared
browser contract no longer contains `baseUrl`, the administrator connection
field starts empty and clears after success, and the bundled UI contains no
literal provider IP. Regression tests assert both top-level and nested
non-disclosure. All 68 tests, lint, TypeScript checks and the production build
pass after the repair.
