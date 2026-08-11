/goal Productionise Video Lab's Firebase, distributed rate limiting, entitlements, financial controls, storage policy, monitoring, and public rollout around the already accepted LongForm creator workflow, without changing or re-testing the model pipeline unless an affected boundary requires it.

Work in:

Video Lab:
`E:\OneDrive\Back-up\Projects\Project_Intelligensi\Video-Lab`

Deploy Studio:
`E:\OneDrive\Back-up\Projects\Project_Intelligensi\Deploy Studio\Intelligensi.ai-Deploy-Studio`

Primary reference:
`Video-Lab/docs/handover/longform-creator-workflow-to-john.md`

Authoritative contracts:

- `Video-Lab/contracts/video-lab.openapi.yaml`
- `Deploy Studio/Intelligensi.ai-Deploy-Studio/docs/intelligensi-runtime-api.openapi.yaml`

## Objective

Take ownership of the production-platform work surrounding Video Lab's tested
creator-to-generation path.

The generation workflow being handed over is:

1. Enter a simple idea, aspect ratio, resolution, and length.
2. Gemma creates exactly the requested storyboard.
3. Review and edit scene, first-frame, and last-frame prompts.
4. Generate and independently regenerate first/last anchors while retaining
   the preceding successful version.
5. Generate an anchored LTX video with clear queue and runtime progress.
6. Cancel or retry without losing successful work or duplicating paid work.
7. Reopen, play, and download the project after refresh/runtime restart.
8. Keep projects, jobs, assets, media, and runtime infrastructure isolated.

Do not redesign or replace this model workflow. Productionise identity,
authorization, durable platform controls, financial enforcement, storage,
observability, and rollout around it.

## Entry gate

Before implementation:

1. Read the complete handover reference.
2. Verify the current branches, remotes, commits, and clean working trees.
3. Confirm that the handover's Gate CWA2 section contains direct paid evidence,
   not `PENDING CWA2` placeholders.
4. Confirm the exact tested LongForm digest and both tested source commits.
5. Confirm the production runtime pin has not changed implicitly.
6. Preserve unrelated work and existing Firebase configuration.

If paid generation evidence is still pending, continue with emulator-safe
platform work but do not claim launch readiness or promote the runtime.

## Responsibility boundary

Video Lab owns Firebase identity, sessions, projects, jobs, assets, queue state,
entitlements, financial records, same-origin media delivery, and public UX.

Deploy Studio owns runtime images, runtime discovery, GPU leases, scheduling,
provider lifecycle, readiness, fencing, shutdown, reconciliation, and rollback.

The LongForm worker owns local Gemma, Z-Image, LTX, job execution, capability
reporting, and media processing. It must not decide identity, entitlement,
billing, or provider lifecycle.

The browser must never receive a runtime origin, provider address, runtime
token, object-store path, runtime job ID, provider instance ID, registry
credential, SSH detail, or raw upstream error.

## Working policy

- Work from evidence and preserve the existing generation contract.
- Commit and push only coherent, tested checkpoints on the agreed feature
  branch. Fetch before each push and never force-push.
- Do not commit `.env`, Firebase service-account material, payment credentials,
  runtime credentials, logs, private prompts, generated media, or test users.
- Use Firebase emulators and mocks for most platform work.
- Do not run Gemma, Z-Image, or LTX locally.
- Do not rerun paid inference merely to test Firebase UI, rules, rate limits,
  wallet logic, dashboards, or alerts.
- Present a separate bounded paid gate only if a changed runtime/gateway/media
  boundary genuinely requires real inference.
- Do not change the production runtime digest, DNS, payments, or public access
  without explicit approval.

## Phase 1: Baseline and threat model

Trace:

```text
browser -> Firebase Hosting -> Video Lab Function/API -> Firestore queue
-> Deploy Studio Runtime API -> LongForm worker -> private Storage
-> authenticated Video Lab media route -> browser blob URL
```

Inventory every trust boundary, service account, secret, callable route,
Firestore collection, Storage prefix, scheduled worker, administrator action,
provider callback, and public browser field.

Update the threat model for:

- Broken authentication and revoked sessions.
- Cross-user IDOR.
- Forged entitlement or balance.
- Duplicate billing/job submission.
- Distributed rate-limit bypass.
- Queue monopolisation.
- SSRF and arbitrary runtime selection.
- Secret or runtime-origin disclosure.
- Unsafe uploads and media paths.
- Stale leases and provider ambiguity.
- Storage exhaustion and deletion failure.
- Administrator abuse and missing audit evidence.

## Phase 2: Production Firebase Authentication

Implement and verify:

- Correct production Firebase project/Hosting target.
- Intended sign-in providers, account recovery, and verified-email policy.
- Server-side Firebase ID-token verification.
- Token refresh, expiry, revocation, disabled users, logout, and reauthentication.
- Secure administrator roles/custom claims controlled only by trusted code.
- No production path accepting local deterministic bearer tokens.
- Safe authentication errors without account enumeration.
- CSRF protections wherever cookie-backed state is introduced.
- Strict CORS/CSP/Permissions-Policy compatible with the deployed product.
- Optional App Check as defence in depth, never as a replacement for auth.

Use two real staging identities and prove that each project, proposal,
generation, asset, download, and cancellation operation is owner-scoped.

## Phase 3: Firestore and Storage

Audit and deploy:

- `firestore.rules`
- `storage.rules`
- `firestore.indexes.json`
- `firebase.json`

Keep API-managed operational collections inaccessible to browser SDK reads and
writes. The server must enforce UID ownership for every public operation.

Validate the documented collections and server-derived storage prefixes in the
handover reference. Add schema/version validation and migrations where needed.

Test:

- Direct cross-user document access.
- Guessed project/generation/asset IDs.
- Owner and non-owner media downloads.
- Upload paths, type spoofing, oversize files, malformed images, and traversal.
- Missing indexes under realistic query shapes.
- Emulator and real staging rules.
- Backup creation and a documented restore exercise.

## Phase 4: Distributed rate and concurrency limits

Replace process-local-only limiting with a shared atomic implementation that
works across multiple Functions instances.

Define and enforce separate limits for:

- Authentication-sensitive actions.
- Director enhancement.
- Project/proposal mutations.
- Upload creation and bytes.
- Generation submission.
- Status polling.
- Cancellation.
- Media downloads.
- Administrator operations.

Enforce per-user, per-workspace, per-IP where appropriate, and global limits.
Keep generation fairness server-side and preserve one active generation per
user unless a paid plan explicitly authorizes more.

Return safe `429` responses with a bounded `Retry-After`. Never let one user
consume every worker or fill the entire durable queue.

Prove the limiter under at least two Functions instances or equivalent staging
concurrency. Process-local unit tests are not sufficient.

## Phase 5: Entitlement and financial boundary

Implement a narrow server-owned entitlement contract:

- The user is authenticated and active.
- The user accepted current required product terms.
- The requested operation is enabled for the account/workspace.
- Sufficient available budget exists.
- Per-operation, per-user, per-day, and global ceilings permit the request.

The browser must not supply an authoritative entitlement, price, discount,
credit cost, wallet balance, or successful-payment flag.

Implement an append-only financial state machine:

```text
estimate -> reserve -> enqueue -> run -> finalize/charge
                           \-> cancel/fail -> release/refund
```

Requirements:

- Reserve credit transactionally with generation/idempotency creation.
- Charge at most once after successful finalization.
- Release/refund at most once after cancellation or terminal failure.
- Bind financial entries to UID, generation, operation, pricing version,
  idempotency key, and safe correlation ID.
- Reconcile ambiguous provider/runtime responses before charging or retrying.
- Never edit ledger history in place.
- Separate payment-provider webhooks from model/runtime decisions.
- Fail closed when entitlement or pricing state is unavailable.

Test duplicate requests, concurrent requests, timeout, worker loss, lease
expiry, output-upload failure, cancellation races, webhook replay, and refund
replay. Prove that each produces no duplicate generation or financial entry.

Do not activate real payments or modify production balances without explicit
approval.

## Phase 6: Storage quotas, retention, deletion, and recovery

Define approved policies for:

- Per-file upload size and media dimensions.
- Per-project references, frames, candidates, and videos.
- Per-user/workspace stored bytes.
- Temporary upload expiry.
- Failed/incomplete artifact cleanup.
- Accepted project retention.
- Account/project deletion windows.
- Backup retention and restoration.

Implement server-enforced quotas and user-facing usage reporting. Never delete
accepted work silently.

Make cascading deletion durable, owner-authorised, idempotent, retryable, and
auditable. Verify Firestore records, Storage objects, queue records, active
locks, and idempotency mappings are removed or retained according to policy.

## Phase 7: Monitoring and operations

Add structured, secret-safe telemetry for:

- Authentication and authorization failures.
- Request rate and distributed limiter decisions.
- Queue depth, oldest age, claim latency, attempt, and reclaim.
- Runtime discovery/readiness and lease fencing.
- Gemma/frame/video stage timings reported through existing public-safe states.
- Idempotent replay and duplicate-prevention invariants.
- Cancellation and controlled failure recovery.
- Storage usage, upload/finalization failure, and deletion backlog.
- Credit reservation, finalization, release, refund, and reconciliation.
- Provider shutdown and unexpected active instances.

Never log credentials, authorization headers, complete prompts, user media,
runtime origins, storage paths, or raw provider errors.

Configure actionable alerts with owners and runbooks for:

- Runtime unavailable or readiness regression.
- Queue age/depth thresholds.
- Stuck claims/leases.
- Elevated generation or upload failures.
- Duplicate-charge/job invariant violations.
- Storage/backup/deletion failures.
- Financial ceiling breaches.
- Missing shutdown or unexpected provider instance.

Verify alert delivery; dashboard existence alone is not acceptance.

## Phase 8: Administrative safety

Preserve or implement authenticated least-privilege controls for:

- Pause/resume submissions.
- Emergency kill switch.
- Runtime health and safe status.
- User suspension.
- Financial adjustment through append-only audited entries.
- Credential rotation.
- Rollback.

Every state-changing administrator request must be authorized, validated,
audited, and protected against CSRF where applicable. Never return stored
credentials or runtime endpoints to an administrator browser.

## Phase 9: Staging acceptance

Run production-like desktop and mobile staging acceptance with Firebase Auth,
Functions, Firestore, Storage, indexes, distributed limits, and safe
observability.

At minimum prove:

1. Sign-up/sign-in, refresh, expiry, revocation, logout, and disabled account.
2. Two-user project, proposal, job, asset, media, and cancellation isolation.
3. Direct Firestore/Storage denial for operational data.
4. Distributed rate limits across multiple instances.
5. Per-user and global queue/concurrency controls.
6. Atomic reserve/charge/release/refund and append-only ledger.
7. No duplicate job or charge after replay, timeout, provider ambiguity, lease
   expiry, or worker loss.
8. Quotas, retention, cascading deletion, backup, and restore.
9. Safe errors, structured metrics, and delivered alerts.
10. Pause, kill switch, credential rotation, application rollback, and runtime
    rollback.
11. Desktop/mobile/keyboard loading and recovery states.
12. Browser network and built-bundle inspection showing no runtime or secret
    disclosure.
13. Final provider inventory with zero unexpected active instances.

Use mocked/stored generation outputs for these tests unless a changed boundary
requires a new real runtime smoke. If real inference is required, stop and
present an exact paid gate with digest, region, GPU, filesystem, time, maximum
cost, shutdown deadline, and cleanup before launching.

## Phase 10: Production rollout

Prepare a versioned release manifest containing:

- Video Lab commit.
- Deploy Studio commit.
- Approved immutable LongForm digest.
- OpenAPI contract hashes.
- Firebase rules/index versions.
- Secret/configuration inventory without values.
- Pricing/entitlement policy version.
- Storage/retention policy version.
- Monitoring and alert evidence.
- Staging acceptance report.
- Rollback revisions.
- Named production approver.

Use a staged/canary rollout. Keep the preceding application revision and
runtime digest deployable. Exercise pause and emergency kill before public
traffic.

Do not deploy production Firebase, enable payments, change DNS, promote a
runtime digest, or open public access until explicitly approved.

## Required tests

Add and run:

- Unit tests.
- OpenAPI and generated-contract checks.
- Firebase Auth emulator tests.
- Firestore and Storage rules tests.
- Distributed concurrency/rate-limit integration tests.
- Entitlement and ledger invariant/property tests.
- Queue, idempotency, retry, and cancellation tests.
- Upload, quota, retention, and deletion tests.
- Monitoring/alert integration tests.
- Production builds with frozen dependency installation.
- Desktop/mobile/keyboard browser acceptance.
- Staging security and IDOR acceptance.

Do not present emulator-only evidence as production staging evidence.

## Completion threshold

This goal is complete only when:

- The handover entry gate is satisfied.
- All Critical/High platform security findings are fixed.
- Real Firebase staging identity and tenant isolation pass.
- Deployed rules/indexes and private media delivery pass.
- Distributed rate/concurrency enforcement passes.
- Financial idempotency proves no duplicate jobs or charges.
- Quota, retention, deletion, backup, and restore pass.
- Metrics and alerts are operational.
- Pause, kill, rollback, and provider cleanup pass.
- Desktop/mobile staging acceptance passes.
- Production remains unchanged until explicit approval.
- Remaining risks are documented honestly.

## Deliverables

Report:

- Architecture and trust boundaries.
- Files changed and commits pushed.
- Firebase project/configuration used without secrets.
- Auth/session/role behaviour.
- Firestore/Storage rules and index evidence.
- Distributed rate/concurrency design and results.
- Entitlement/wallet/ledger contract and invariant results.
- Storage quota/retention/deletion/backup policy and tests.
- Monitoring, dashboards, alerts, and runbooks.
- Security findings and repairs.
- Desktop/mobile staging results.
- Rollout, rollback, and kill-switch procedure.
- Paid inference avoided or separately approved, with reason.
- Provider cleanup confirmation.
- Remaining risks and explicit production approvals still required.

Do not claim production readiness from configuration files or unit tests alone.
Require direct staging evidence for every completion item.
