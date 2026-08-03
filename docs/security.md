# Security

The browser never talks to the GPU runtime and never supplies identity, credit cost, entitlement or an upstream URL. Production verifies Firebase bearer identity, enforces admin roles server-side and authorises every draft, asset, generation, job and download against the caller.

Runtime and Gemma endpoints/tokens are server-only. Origins must be HTTPS, origin-only and allow-listed in production; redirects and cross-origin artifact URLs are rejected. Firestore and Storage rules deny direct client access to API-managed operational data. Uploads and outputs cross the same-origin API after type, size and ownership validation.

Runtime discovery keeps the resolved origin in a server-only structure. Public and administrator status responses expose only the connection source, state, safe message and lease timestamps. A manually entered emergency origin is cleared from the administrator form after a successful connection and is never returned by the API.

Responses use safe problem classifications and correlation IDs. Prompts, credentials and raw upstream errors are not logged. See `public-runtime-readiness.md` for the threat model and outstanding deployment controls.
