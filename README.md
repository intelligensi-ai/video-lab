# Intelligensi.ai Video Lab

A TypeScript monorepo for the Intelligensi.ai video-creation product. The app
provides a React creator studio, an Express/Firebase-compatible API, a
provider-neutral generation queue and an authenticated adapter to Deploy
Studio-managed LongForm runtimes.

The current user-facing application is:

<https://intelligensi-video-lab.web.app/videolab>

## Structure

- `contracts/video-lab.openapi.yaml` authoritative API contract.
- `apps/web` Vite React consumer UI.
- `apps/api` Express API suitable for Firebase Functions Gen 2.
- `packages/domain` credits, queue, state machine, future payment interfaces.
- `packages/runtime-adapter` provider-neutral mock and Sulphur/LTX adapters.
- `firestore.rules`, `storage.rules`, `firebase.json` Firebase setup.

## Prerequisites

- Node.js 22 or newer.
- pnpm 10.28.1 (the version declared by the repository).
- Firebase CLI when running the Firebase emulators.
- Playwright browsers only when running browser E2E tests.

Do not download Gemma, Z-Image or LTX models to run the interface locally. The
mock runtime is sufficient for frontend, API and workflow development. Real
inference belongs on an approved Deploy Studio-managed GPU runtime.

## Launch locally with the mock runtime

The following is the recommended Windows PowerShell quick start. It launches
the web app and API without using paid infrastructure:

```powershell
Set-Location "E:\OneDrive\Back-up\Projects\Project_Intelligensi\Video-Lab"

corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm openapi:generate

$env:VIDEO_RUNTIME_PROVIDER = "mock"
$env:VIDEO_LAB_LOCAL_AUTH = "true"
$env:VITE_API_BASE_URL = "/api"

pnpm dev
```

Open:

- Creator interface: <http://localhost:5173/videolab>
- Advanced Director workspace: <http://localhost:5173/storyboard/advanced>
- API health through the Vite proxy: <http://localhost:5173/api/v1/health>
- Direct API health: <http://localhost:5001/v1/health>

Vite listens on port `5173`. The Express API listens on port `5001`, and the
Vite development server proxies `/api` to it. Stop all local processes with
`Ctrl+C` in the terminal that is running `pnpm dev`.

Local development does not require a Firebase sign-in. The API accepts a
deterministic local bearer principal when `VIDEO_LAB_LOCAL_AUTH=true`;
`admin-token` simulates the administrator claim for API tests. These shortcuts
are disabled in production.

### Environment files

`.env.example` documents the complete configuration contract. Do not put
credentials into Git and never prefix a server credential with `VITE_`, because
Vite variables are included in the browser bundle.

The API reads its configuration from the process environment. Set the required
variables in the terminal or through the approved service secret manager. A
root `.env.local` file is not automatically loaded by the standalone API.

For real managed-runtime development, use these server-side settings as the
starting boundary:

```text
VIDEO_RUNTIME_PROVIDER=intelligensi-api
VIDEO_RUNTIME_BASE_URL=<approved Deploy Studio gateway origin>
VIDEO_LAB_RUNTIME_API_KEY=<server-side service credential>
VIDEO_RUNTIME_ID=longform-ltx-storyboard-studio
VIDEO_RUNTIME_PAYLOAD_MODE=deploy-studio
VIDEO_RUNTIME_ALLOW_ENV_FALLBACK=false
```

Never place a Lambda key, worker URL, runtime bearer token or private storage
path in the web app, a `VITE_` variable, source control or browser-visible
configuration. Video Lab should call only its same-origin `/api` routes; its
backend communicates with the allow-listed Deploy Studio gateway.

## Use Video Lab

### Production creator workflow

1. Open <https://intelligensi-video-lab.web.app/videolab> and sign in.
2. Enter a simple description in **Describe your video**. Everyday language is
   sufficient.
3. Choose the video model, aspect ratio, resolution and length. LTX 2.3 remains
   the proven default. LTX 2.5 is selectable only when an approved compatible
   runtime advertises that it is ready.
4. Select **Improve with Director**. Video Lab divides the selected total length
   into the smallest balanced set of 1-8 second scenes, then queues the request
   durably. The Director creates the content for exactly that application-owned
   scene count; it cannot change the requested total duration or scene order.
5. Submission returns immediately. The page shows queued, model-starting,
   planning and validation stages while the local Gemma Director creates the storyboard.
   Refreshing reconnects to the same job rather than starting again.
6. Review and edit the scene direction, first-frame prompt and last-frame
   prompt. Generated text remains editable.
7. Generate the first and last anchor frames. Either frame can be regenerated
   independently; keep the previous successful version until its replacement
   succeeds.
8. Generate the scene or complete video. Queueing, runtime startup, rendering,
   processing and completion should appear as distinct states.
9. Cancel or retry when offered. A retry should preserve successful prompts,
   frames and accepted videos.
10. Play or download the completed video, or reopen the project later from the
    gallery.

Use **Advanced** only when detailed scene, reference and Director controls are
needed. The minimal `/videolab` workspace is the normal creator entry point.

The default Creator policy does not request captions, subtitles, title cards,
text overlays, logos, watermarks or readable signage. That policy is enforced by
the Director contract, frame/video workflow prompts, stream stripping, runtime
visible-text checks and a fail-closed Video Lab completion boundary. Quoted
dialogue does not imply burned-in subtitles. If text is artistically required,
use a separately reviewed advanced project policy; the minimal Creator does not
silently enable it.

See [Minimal Creator launch contract](docs/minimal-creator-launch-contract-2026-08-17.md)
for the complete Director, scene-duration, generated-text and acceptance
boundaries.

Use the [Minimal Creator launch runbook](docs/creator-minimal-launch-runbook-2026-08-17.md)
as the consolidated developer and operator reference for architecture,
Director input/output, semantic memory, LTX model differences, caption and
audio enforcement, local verification, paid acceptance and deferred ownership.

### Runtime unavailable

`Generator unavailable` means Video Lab cannot currently obtain a compatible
ready lease from Deploy Studio. It does not mean the user should enter a worker
URL or token.

An operator should:

1. Launch or assign the required LongForm model through Deploy Studio.
2. Wait for the runtime to report real Gemma, frame and video readiness.
3. Confirm the selected model is advertised through the stable Runtime API.
4. Refresh Video Lab and retry the operation.

When deployed behind Firebase Hosting, browser Director calls use the durable
`POST /api/v1/storyboard-enhancements` or
`POST /api/v1/storyboards/director/jobs` submit contract, followed by short
owner-scoped status requests. `processVideoLabJobs` performs the long internal
Gemma call through Cloud Tasks. Do not route a multi-minute model request
through one synchronous Hosting rewrite, which has a fixed request deadline.

The API checks revoked Firebase ID tokens in production. Model submissions also
require a server-owned entitlement. Production defaults to Firestore-backed,
fail-closed `videoLabEntitlements/{uid}` records; a bounded
`VIDEO_LAB_ENTITLEMENT_MODE=staging_allowlist` deployment may be used for live
acceptance with explicitly listed Firebase UIDs. Browser fields never decide
entitlement, price or settlement.

### Local mock behaviour

The local mock runtime validates the product flow and UI states, but it does
not prove Gemma, Z-Image or LTX inference. Mock outputs must never be reported
as real model acceptance.

## Emulators

```bash
pnpm dev:emulators
pnpm seed
```

The seed writes `firebase/seed/demo.json` with demo users, wallets, generations, runtime state, and metrics-shaped data.

## Testing and build

```bash
pnpm lint
pnpm typecheck
pnpm openapi:lint
pnpm test
pnpm test:rules
pnpm test:e2e
pnpm build
```

## Admin claim

Production verifies Firebase ID tokens with the Admin SDK. Run a privileged
Admin SDK script or callable operation to set `{ admin: true }` on the Firebase
user, then send that user's ID token as the bearer token. Local development and
API tests may use `Authorization: Bearer admin-token`; this shortcut is disabled
in production.

## LongForm LTX runtime

Production receives a short-lived, server-only LongForm runtime lease from Deploy Studio. The browser calls only Video Lab `/api` routes; it never receives the runtime endpoint, token, job identifier or storage path. Environment fallback is disabled in production unless it is explicitly enabled for a controlled migration.

Prompt planning uses Deploy Studio's local Gemma enhancer. There is no paid browser LLM fallback. See [public runtime readiness](docs/public-runtime-readiness.md), [LongForm feature parity](docs/longform-feature-parity.md), and [runtime adapter](docs/runtime-adapter.md).
