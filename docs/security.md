# Security

The browser never talks to the GPU runtime and never supplies identity, credit cost, entitlement or an upstream URL. Production verifies Firebase bearer identity, enforces admin roles server-side and authorises every draft, asset, generation, job and download against the caller.

Runtime and Gemma endpoints/tokens are server-only. Origins must be HTTPS, origin-only and allow-listed in production; redirects and cross-origin artifact URLs are rejected. Firestore and Storage rules deny direct client access to API-managed operational data. Uploads and outputs cross the same-origin API after type, size and ownership validation.

Public gallery filters are type-checked and capped at 50 before reaching Firestore. The process-local rate limiter periodically removes expired identities and enforces a 10,000-bucket memory ceiling; a distributed edge limiter is still required for coordinated production enforcement across instances.

Runtime discovery keeps the resolved origin in a server-only structure. Public and administrator status responses expose only the connection source, state, safe message and lease timestamps. A manually entered emergency origin is cleared from the administrator form after a successful connection and is never returned by the API.

Responses use safe problem classifications and correlation IDs. Prompts, credentials and raw upstream errors are not logged. See `public-runtime-readiness.md` for the threat model and outstanding deployment controls.

Deterministic local bearer identities are available only when `NODE_ENV=test` or `VIDEO_LAB_LOCAL_AUTH=true`; the explicit flag is ignored in production. Production runtime origins must use HTTPS even when allow-listed.
