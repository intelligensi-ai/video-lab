# Security

The browser never talks to the GPU runtime and never supplies identity, credit cost, entitlement or an upstream URL. Production verifies Firebase bearer identity, enforces admin roles server-side and authorises every draft, asset, generation, job and download against the caller.

Runtime and Gemma endpoints/tokens are server-only. Origins must be HTTPS, origin-only and allow-listed in production; redirects and cross-origin artifact URLs are rejected. Firestore and Storage rules deny direct client access to API-managed operational data. Uploads and outputs cross the same-origin API after type, size and ownership validation.

Public gallery filters are type-checked and capped at 50 before reaching
Firestore. A small process-local limiter protects the general API boundary.
Generation-facing routes additionally use a Firestore transactional counter so
limits remain coordinated across multiple Functions instances; a rate-store
failure rejects the request rather than silently disabling enforcement.

Production checks Firebase ID tokens with revocation enabled. Optional Firebase
App Check can be required as defence in depth after its web provider is
configured, but it never replaces authentication. Bearer headers and
credential-free CORS mean the API does not use cookie-authenticated mutation
requests, avoiding a hidden CSRF trust boundary.

Director and generation submissions require a server-owned entitlement. Each
accepted job stores a private zero-cost authorisation reservation with the
policy version and operation. Completion settles it once; cancellation or
failure releases it once. Replaying the same idempotency key cannot create a
second job, while changing the payload under that key is rejected. These
technical records do not activate pricing or a payment provider.

Runtime discovery keeps the resolved origin in a server-only structure. Public and administrator status responses expose only the connection source, state, safe message and lease timestamps. A manually entered emergency origin is cleared from the administrator form after a successful connection and is never returned by the API.

Responses use safe problem classifications and correlation IDs. Prompts, credentials and raw upstream errors are not logged. See `public-runtime-readiness.md` for the threat model and outstanding deployment controls.

Deterministic local bearer identities are available only when `NODE_ENV=test` or `VIDEO_LAB_LOCAL_AUTH=true`; the explicit flag is ignored in production. Production runtime origins must use HTTPS even when allow-listed.
