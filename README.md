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
Production: run a privileged Admin SDK script or callable operation to set `{ admin: true }` on the Firebase user. Local API tests use `Authorization: Bearer admin-token`.

## Sulphur/LTX runtime
Set `VIDEO_RUNTIME_PROVIDER=sulphur-ltx`, `VIDEO_RUNTIME_BASE_URL`, and `VIDEO_RUNTIME_API_TOKEN`. Provider-specific payload mapping stays inside `packages/runtime-adapter` and never reaches browser contracts.
