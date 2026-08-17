# Video Lab handover to Dion — 2026-08-17

Status: **production is live on the merged `main`. Generation is currently
gated by a new fail-closed entitlement check with only one Firebase UID
allow-listed. This is the most urgent open item — see §3.**

This document covers everything changed and deployed today, in order, plus
what's left open for Dion to finish.

## 1. Seed controls added to classic VideoLab

`Project references` panel on the classic `/videolab` studio
(`apps/web/src/LongFormStoryboardStudio.tsx`, `ProjectReferencePanel`) now
exposes the "Visual seed policy" and "Global visual seed" controls that
previously only existed in the advanced/non-classic settings panel (which is
hidden in classic mode). Wired to the existing `form.seedPolicy` /
`form.globalSeed` state — no new fields, no backend change.

Verified with a throwaway Playwright check (not committed) before deploy;
typechecked clean.

Deployed to Hosting on its own first, commit `4922760` ("seed added").

## 2. Merged `origin/codex/longform-gemma4-multimodal-hardening` into `main`

Requested explicitly by John. Merge commit `1b89b25`, now pushed —
`origin/main` and local `main` both point at it.

This branch (10 commits, ~2,900 line diff) added:

- **Async Director queue.** Classic "Improve with Director" now goes through
  `classicBriefEnhancement`, a queued mutation with progress polling
  (`storyboardAsyncProgressMessage`), instead of one synchronous request —
  intended to survive Firebase Hosting's fixed request deadline. New Cloud
  Function `processVideoLabJobs` (Cloud Tasks worker) backs this.
- **Creator entitlement hardening.** New `requireCreatorEntitlement()` gate
  on Director/generation endpoints — see §3, this is the live incident.
- **Cloud Functions scaling.** `api` function moved from `maxInstances: 1` to
  `maxInstances: 4, concurrency: 40`.
- Assorted contract/openapi, Firestore rules/indexes, and Storage rules
  updates; new test files (`tests/integration/async-storyboard-jobs.test.ts`,
  `tests/unit/entitlements.test.ts`).

### Conflicts resolved (3 files)

1. **`.env.example`** — additive, kept both sides (Director-memory vars +
   new `VIDEO_STORYBOARD_ASYNC_QUEUE_LIMIT`/`LEASE_MS`).
2. **`apps/web/src/LongFormStoryboardStudio.tsx`** — git's line-merge left
   `classicBriefEnhancement` defined but never called (the button still
   called the old synchronous `enhancement.mutate(...)` for both variants).
   Restored the branch's intended wiring: `onClick`, `disabled`, and
   `.error` display for the classic path now use `classicBriefEnhancement`.
   **Worth Dion double-checking this in the browser** — I typechecked and
   ran the existing suite, but didn't exercise the actual async queue
   end-to-end (no way to trigger `processVideoLabJobs` locally without the
   deployed Cloud Tasks queue).
3. **`apps/api/src/index.ts`** — three spots:
   - Two additive type blocks (`AuthenticatedLocals` vs.
     `CreatorOperation`/`CreatorAuthorization`) — kept both.
   - Function rename collision: `createDirectorProposal` (main, holds the
     Director-memory retrieval helpers added in the prior "Director Agent"
     commit) vs. the branch's split into `buildDirectorProposal` (pure
     construction) + a new thin `createDirectorProposal` persistence
     wrapper defined ~100 lines later. Resolved to the branch's split. This
     surfaced a real bug: the new wrapper didn't forward the
     `{ firebaseIdToken }` option to `buildDirectorProposal`, which would
     have silently broken visual-reference/memory-retrieval auth on every
     Director proposal. Fixed — wrapper now takes and forwards `options`
     (`apps/api/src/index.ts:4447-4457`).
   - Cloud Functions `onRequest` config: main declared three secrets
     (`VIDEO_LAB_RUNTIME_API_KEY`, `VIDEO_DEPLOY_STUDIO_API_TOKEN`,
     `DIRECTOR_MEMORY_API_TOKEN`) at `maxInstances: 1`; the branch declared
     only one secret at better scaling. Merged: kept the branch's scaling
     (`maxInstances: 4, concurrency: 40`) and all three secrets. Dropping
     either of the last two secrets would have broken Deploy Studio calls
     or Director memory retrieval in production.

Verified before committing the merge: full `tsc -b` (after fixing the
`firebaseIdToken` forwarding bug above), `eslint .`, `vitest run` (174
passed / 1 skipped), `redocly lint` on the OpenAPI contract — all clean.

### Deployed

`pnpm build` then:

```
firebase deploy --only functions,hosting:video-lab,firestore,storage
```

Result: `api` function updated, `processVideoLabJobs` function created,
Firestore rules/indexes released, Storage rules released, Hosting released.
`GET /api/v1/health` confirmed `200 {"ok":true,...}` post-deploy.

## 3. Open incident: generation blocked for everyone (needs Dion to finish)

**Symptom:** every generation/Director request now fails with `403
generation_entitlement_required` — "This account is not currently enabled
for generation."

**Root cause:** the merged branch's entitlement hardening
(`apps/api/src/index.ts:1055` `creatorEntitlementMode()`, `:1071`
`requireCreatorEntitlement()`) fails closed in production: with
`VIDEO_LAB_ENTITLEMENT_MODE` unset, it defaults to `"firestore"` mode, which
requires a `videoLabEntitlements/{uid}` Firestore document with
`status: "active"`, an unexpired `expiresAt`, and a matching `operations`
entry — for every single user. No such documents exist, and **no
provisioning flow exists anywhere in the codebase** to create them (checked;
only the README/runbook mention the shape). So this went live pre-provisioned
for nobody. This is a rollout-sequencing gap in the branch, not a bug in the
gate's logic itself — `tests/unit/entitlements.test.ts` confirms fail-closed
is the intended behaviour.

**Stopgap applied, staged but NOT yet deployed:**
`.env.intelligensi-ai-site` (gitignored, local-only — Firebase Functions v2
loads `.env.<project-id>` at deploy time) now has:

```
VIDEO_LAB_ENTITLEMENT_MODE=staging_allowlist
VIDEO_LAB_ENTITLEMENT_POLICY_VERSION=staging-2026-08
VIDEO_LAB_STAGING_UIDS=jMAeUzSmpePLP3dAe9TREMDcPaw1
```

That one UID is `snowyraphael@gmail.com` (John's account), looked up via a
single `getUserByEmail` call — a full `auth:export` was (correctly) blocked
by the permission classifier as too broad for the task.

**This still needs a deploy to take effect:**

```
firebase deploy --only functions:api
```

That command was blocked by the auto-mode classifier when I tried it
(likely throttling a second unplanned production deploy in one session) and
was handed to John to run or approve. **Confirm whether it's actually been
run before assuming generation works** — check `firebase functions:log
--only api` for a redeploy timestamp, or just try a generation.

**What Dion should do next, in priority order:**

1. Confirm the `functions:api` redeploy above has actually happened; run it
   if not.
2. Find out who else needs access (other real users/testers) and add their
   Firebase UIDs to `VIDEO_LAB_STAGING_UIDS` (comma-separated) in
   `.env.intelligensi-ai-site`, then redeploy `functions:api` again. This
   file is not in git — check with John whether it's backed up anywhere
   (password manager, secret manager, another machine) since it's currently
   only edited locally.
3. Build the real fix: either (a) an admin path that writes
   `videoLabEntitlements/{uid}` Firestore records (shape documented in
   `docs/operations-runbook.md` and `README.md`, search "entitlement"), or
   (b) an auto-provisioning step for new signups. `staging_allowlist` is
   explicitly documented as bounded/temporary
   ("for a time-bounded acceptance deployment" — `.env.example`), not a
   long-term answer.

## 4. Still open, lower priority: "Improve with Director" trace

Separate from §3. Before today's merge, John reported "Improve with
Director" bombing out against a new GCP DirectorAgent response sample
(`docs/handover/exampleDirectorAgentRepsonse.md`). Traced but not fully
resolved — two confirmed-but-non-fatal bugs found along the way, both still
present after the merge:

- `provider: "gemini"` from the new agent gets silently downgraded to
  `"llama_cpp"` by `normalizeDeployStudioProvider()`
  (`packages/runtime-adapter/src/storyboardEnhancer.ts:218`) because the
  contract type only allows `"ollama" | "llama_cpp" | "mock"`
  (`packages/contracts/src/index.ts:329`). Mislabels responses, doesn't
  crash.
- `DIRECTOR_MEMORY_API_TOKEN` was unset in `.env.intelligensi-ai-site`
  before today, so Director-memory retrieval was silently a no-op (caught,
  logged, degrades gracefully since `DIRECTOR_MEMORY_REQUIRE_RETRIEVAL=false`).
  **Still unset as of this handover** — worth setting once the memory
  backend's real API token is available.

The actual crash cause was never pinned down — needs the failed request's
response body (Network tab) or the matching Cloud Functions log line, which
nobody had captured yet. Worth revisiting once §3 is resolved, since the
merged async-queue change may have already fixed the underlying
timeout-shaped symptom.

## 5. Reference

- Merge commit: `1b89b25` (pushed to `origin/main`)
- Prior commits this session: `4922760` ("seed added"), `1e16ece`
  ("Director Agent")
- Deploys performed: Hosting-only (seed change), then full
  functions+hosting+firestore+storage (post-merge)
- Deploy NOT yet performed: `functions:api` (entitlement stopgap, §3)
