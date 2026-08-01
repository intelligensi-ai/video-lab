# Intelligensi.ai Video Lab

A TypeScript monorepo for a polished OpenAPI-first AI video creation trial at `trial.intelligensi.ai`. The app provides a React studio, Express/Firebase-compatible API, credit ledger domain model, Firestore-backed queue design, mock runtime, and isolated Sulphur/LTX adapter.

## Structure

- `contracts/video-lab.openapi.yaml` authoritative API contract.
- `apps/web` Vite React consumer UI.
- `apps/api` Express API suitable for Firebase Functions Gen 2.
- `packages/domain` credits, queue, state machine, future payment interfaces.
- `packages/runtime-adapter` provider-neutral mock and Sulphur/LTX adapters.
- `firestore.rules`, `storage.rules`, `firebase.json` Firebase setup.

## Prerequisites

Node.js 22+, pnpm 10+, Firebase CLI for emulators/deploy, and Playwright browsers for E2E.

## Local setup

```bash
pnpm install
pnpm openapi:generate
pnpm dev
```

Use `.env.example` as a template. Local API auth accepts any bearer token as a deterministic emulator principal; `admin-token` simulates an admin custom claim.

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
