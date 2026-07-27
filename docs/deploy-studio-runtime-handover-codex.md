# Codex brief: Deploy Studio → Video Lab runtime handover

Use this brief in the Deploy Studio repository.

## Objective

Implement automatic, secure discovery of the currently running Lambda Labs
LongForm/LTX runtime by publishing a renewable lease to the Firebase project
`intelligensi-ai-site`. Video Lab must never require a user to copy an IP
address.

Do not change the existing generation API contract:

- `GET /health`
- `POST /preview`
- `GET /jobs/{jobId}`
- `POST /jobs/{jobId}/cancel`
- `GET /jobs/{jobId}/output`
- `POST /prompt/complete`

## Firestore handover contract

Use the Firebase Admin SDK on the server. Never call Firestore from browser
code and never ship a service-account key to the client.

Publish exactly one document:

```text
runtimeDiscovery/current
```

with this shape:

```json
{
  "schemaVersion": 1,
  "source": "deploy-studio",
  "status": "ready",
  "baseUrl": "https://CURRENT_RUNTIME_ORIGIN",
  "instanceId": "stable Lambda instance identifier",
  "worker": "longform-ltx-storyboard-studio",
  "heartbeatAt": "server timestamp",
  "leaseExpiresAt": "timestamp 75 seconds in the future",
  "updatedAt": "server timestamp"
}
```

Allowed `status` values are `starting`, `ready`, `stopping`, `stopped`, and
`error`.

`baseUrl` is an origin only: protocol, hostname/IP and optional port. It must
not contain credentials, paths, query strings, fragments or the runtime API
token. Prefer HTTPS with a valid certificate.

## Publisher behaviour

1. At Deploy Studio startup, determine the Lambda instance's current public
   runtime origin from the same authoritative instance data used by its
   dashboard. Do not scrape UI text.
2. Write `status: "starting"` while the instance or runtime is booting.
3. Poll the runtime's `GET /health` endpoint.
4. Only publish `status: "ready"` when the response is successful and reports
   ready/healthy.
5. While ready, renew `heartbeatAt`, `leaseExpiresAt`, and `updatedAt` every
   20 seconds. Each lease expires 75 seconds after it is written.
6. If health fails twice consecutively, publish `status: "error"` and stop
   renewing a ready lease.
7. Before an intentional stop/release, publish `status: "stopping"`, stop the
   runtime, then publish `status: "stopped"` with the endpoint removed or set
   to `null`.
8. If the Lambda IP changes, health-check the new origin and atomically replace
   the document. Do not wait for an operator.
9. Use a single-process mutex or transaction so overlapping timers cannot
   publish out-of-order leases.
10. Shut the heartbeat down cleanly on `SIGINT` and `SIGTERM`.

## Credentials and permissions

Use Application Default Credentials or a dedicated service account supplied as
a server-side secret. Grant only the minimum IAM permissions required to read
and write `runtimeDiscovery/current`. Do not reuse a browser Firebase API key
as an administrative credential.

Never log:

- service-account JSON
- access tokens
- the Video Lab runtime API token
- request authorization headers

It is acceptable to log the instance ID, state transitions, lease expiry and a
redacted endpoint hostname.

## Configuration

Support these environment variables:

```text
VIDEO_LAB_FIREBASE_PROJECT_ID=intelligensi-ai-site
VIDEO_LAB_RUNTIME_DISCOVERY_COLLECTION=runtimeDiscovery
VIDEO_LAB_RUNTIME_DISCOVERY_DOCUMENT=current
VIDEO_LAB_RUNTIME_HEARTBEAT_SECONDS=20
VIDEO_LAB_RUNTIME_LEASE_SECONDS=75
VIDEO_LAB_RUNTIME_PROTOCOL=https
VIDEO_LAB_RUNTIME_PORT=
```

Validate heartbeat and lease values at startup. The lease must be at least
twice the heartbeat interval.

## Tests

Add automated tests covering:

- starting → ready publication
- heartbeat renewal
- IP/origin replacement
- two failed health checks → error
- intentional stop → stopped with no usable endpoint
- lease timestamps use server time
- secrets never appear in logs
- publisher recovers after a transient Firestore failure
- duplicate heartbeat loops cannot start

Provide a local emulator mode for Firestore contract testing.

## Delivery

Implement the publisher as a small isolated service/module, document how it is
started with Deploy Studio, run the tests, and report:

- files changed
- environment variables added
- IAM/service-account setup required
- test results
- one example redacted Firestore document

Do not deploy until explicitly instructed.
