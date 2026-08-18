# John / Claude handover: finish and deploy the LongForm Creator MVP

Copy everything from `/goal` onward into Claude. This prompt is intentionally
self-contained. It records what is already proven, what must not be repeated,
the exact remaining acceptance boundary, and the live Firebase deployment
blocker observed on 18 August 2026.

---

/goal Finish the remaining LongForm Creator MVP acceptance on `main`, deploy the
verified Video Lab application through John's authorised Firebase account, and
leave an evidence-backed production-promotion recommendation without changing
runtime production pins or launching unapproved infrastructure.

## Work in

Video Lab:

`E:\OneDrive\Back-up\Projects\Project_Intelligensi\Video-Lab`

Deploy Studio:

`E:\OneDrive\Back-up\Projects\Project_Intelligensi\Deploy Studio\Intelligensi.ai-Deploy-Studio`

Temporary evidence:

`E:\tmp\intelligensi-video-lab-mvp-final-acceptance`

## Immediate objective

Take over the nearly complete Video Lab Creator MVP. Preserve all accepted
Gemma, Z-Image and LTX evidence. First deploy the already-tested application
changes to the live Video Lab using an account with access to Firebase project
`intelligensi-ai-site`. Then finish only the narrow paid acceptance that remains
when approved H100 capacity is available.

Do not reconstruct the project from old chat messages. Treat the repositories,
the documents named below and the immutable digests in this prompt as the
authoritative state.

## Current repository state

Both repositories work directly on `main`.

At handover preparation:

- Video Lab functional application head:
  `f13c158c6b529ca8c885755bc7aa31e1f39c6b60`.
  - `0aa1f404e731d8451fa7d3a4ba741dfdb618f03f` contains the bounded transient
    runtime-status recovery repair.
  - `f2ecf27`, `25b89e8` and `03afd9c` are John's later mainline documentation
    and accepted-generation UI fixes.
  - `f13c158` prevents stale cancellation or completion updates from
    overwriting an already-terminal generation.
- Deploy Studio functional/evidence head:
  `1adf74207efae021e176908a13e646db4633a790`.
- Fetch `origin/main` in both repositories before doing anything. Preserve new
  changes and never force-push or rewrite shared history.

Read first:

1. Video Lab `docs/handover/README.md`.
2. This file.
3. Deploy Studio
   `docs/runtime-validation/longform-mvp-completion-ledger-2026-08-18.md`.
4. Deploy Studio
   `docs/runtime-validation/longform-gate-a16-cwa1-result-2026-08-18.md`.
5. Video Lab `README.md` and `docs/deployment.md`.
6. Video Lab `contracts/video-lab.openapi.yaml`.
7. Deploy Studio `docs/intelligensi-runtime-api.openapi.yaml`.

## Immutable runtime candidates

LTX 2.5 Preview A16:

- digest:
  `sha256:fe2154a77ccdb3ecc08f65ab969e279c3faf735049b5bc92c3833457045f6a73`
- filesystem: `intelligensi-longform-ltx25-us-west-3`
- approved GPU/region: `gpu_1x_h100_pcie` in `us-west-3`

LTX 2.3 A16:

- digest:
  `sha256:47bcfa74123fb7b1e3340775da50d065453ffbcd5c82a0045f758f92a4a71668`
- filesystem: `intelligensi-longform-us-west-3`
- LTX 2.3 may run only after the focused LTX 2.5 completion gate passes.

Both production pins remain unchanged. Neither A16 candidate has been promoted.

## What is already proven live and must not be repeated unnecessarily

CWA1R3 run `vl-e2e-2608182019-1b30ab` proved on the immutable A16 LTX 2.5
candidate:

- real Gemma exact two- and five-scene storyboards;
- targeted Scene 2 regeneration while Scene 1 remained byte-identical;
- silent and explicit-music Director policy;
- prompt-injection resistance at application-owned controls;
- all four Z-Image first/last anchors for two scenes;
- independent first- and last-frame regeneration;
- preservation of previous successful frames and unrelated anchors;
- controlled replacement failure without loss of the previous frame;
- caption/text-overlay suppression on accepted frames and videos;
- one valid two-second start/end-anchored LTX 2.5 video at 1024x576, 24 fps,
  48 frames, H.264 and no audio;
- anchored video SHA-256:
  `2ADD39A9C608D6B2C87BF2E0316BCCE07BA0ACF2713D9EB4D631A1A254940D07`;
- start/end anchor SSIM `0.939532` / `0.446595` against the `0.25` floor;
- one valid LTX 2.5 text-only video, no audio, SHA-256:
  `02CFFB9F90ABCD3A78494E1FE3DE06E07E085BBAB4A2537599B5F067389069A2`;
- controlled failure, retry and completed-job idempotency;
- deterministic FIFO, per-user concurrency, owner cancellation, repeated
  cancellation and cross-user read/cancel denial;
- authenticated delivery through Video Lab; direct unauthenticated worker
  access returned 401.

The worker was terminated and the provider returned to the pre-run baseline.
Approximate CWA1R3 compute was USD `$1.92`.

CPU-safe verification at the functional checkpoints passed:

- Video Lab: 190 tests, TypeScript, ESLint, OpenAPI and production build.
- Deploy Studio: 90 application tests, 95 LongForm runtime tests, TypeScript and
  production build.

Do not rerun the expensive Gemma, four-anchor, start/end or text-only matrix
unless a change affects the runtime, gateway, prompt, anchor or generation
contract.

## Repaired defect awaiting focused live proof

During CWA1R3, Video Lab marked an LTX 2.5 start-frame-only request failed after
a transient status request failure even though the immutable runtime job was
still running in `generating_scene`.

Video Lab commit `0aa1f404e731d8451fa7d3a4ba741dfdb618f03f` repairs this by:

- retrying only transient runtime-status failures for a bounded 45 seconds;
- polling the same opaque runtime job identifier;
- never resubmitting the paid job;
- failing non-transient 4xx, authentication, schema and terminal runtime errors
  immediately; and
- redacting upstream response bodies.

Deploy Studio commit `37ed1949a7375c22f620be609c4f7078d4f03d23`
adds start-only graph regression coverage and better bounded diagnostics. No new
runtime image is required because neither repair changes the immutable runtime
container.

## Unconsumed paid gate and capacity result

Gate A16-CWA1R4 was approved but no paid worker was launched. A provider
preflight and a 30-minute, 20-second-interval capacity watcher found no
`gpu_1x_h100_pcie` availability in `us-west-3`.

Preflight evidence:

`E:\tmp\intelligensi-video-lab-mvp-final-acceptance\gate-a16-cwa1r4-preflight\vl-e2e-2608182115-e5bd90\results.json`

It verified:

- all 9 pinned model artifacts were accessible;
- total verified cache release size was 60,383,917,750 bytes;
- the isolated LTX 2.5 filesystem existed and was detached;
- quoted H100 PCIe rate was USD `$3.29/hour`;
- no run-scoped instance was launched;
- compute and image-transfer cost was `$0`;
- one unrelated baseline provider instance remained and must not be touched.

The approval is unconsumed, but it is bound to the exact revisions stated in
the original approval: Deploy Studio `1adf742...` and Video Lab `0aa1f404...`.
Because Video Lab `main` now contains John's additional commits, obtain a short
revised approval that binds the gate to the exact current `origin/main` commit
before testing current main. Do not silently reinterpret the old approval.

The focused gate must:

1. run one bounded start-frame-only LTX 2.5 generation;
2. prove the same runtime job survives a transient status failure without a
   duplicate submission;
3. prove project persistence, refresh/reopen and accepted-generation identity;
4. restart the runtime container and prove identical frame/video hashes;
5. prove authenticated same-origin playback/download;
6. perform minimal desktop/mobile Video Lab acceptance;
7. terminate the worker and independently confirm no run-scoped instance;
8. only after the complete LTX 2.5 pass, run the A16 LTX 2.3 matrix sequentially;
9. never overlap the two workers.

Do not launch replacements automatically. Do not touch unrelated provider
instances. Arm the approved shutdown guard before every paid launch.

## Live Firebase deployment

The checked-in Firebase project is `intelligensi-ai-site` and the Hosting target
is `video-lab` / site `intelligensi-video-lab`.

The handover machine's active Firebase account could authenticate but could see
only project `intelligensi-signal-dev`. Firebase returned HTTP 403 for the
`intelligensi-ai-site` Hosting target and could not list its deployed functions.
Therefore no live deployment was attempted. GitHub Actions currently performs
CI only; pushing `main` does not deploy Firebase.

John must use an account with explicit access to `intelligensi-ai-site`, or grant
the required least-privilege IAM access, before deployment.

The checked-in deployment contains:

- Firebase Hosting target `video-lab`;
- HTTPS function `api`;
- private task function `processVideoLabJobs`;
- Firestore rules and indexes;
- Storage rules.

The transient status-recovery repair is backend code. A Hosting-only deployment
is insufficient. Deploy the API and job processor together with the matching
web build after verifying the current server-side runtime and Director secrets.
Do not retrieve or print secret values.

Before deploying:

1. Fetch both `origin/main` branches and inspect any changes after the handover.
2. Confirm the Video Lab worktree is clean.
3. Confirm the Firebase CLI account can list `intelligensi-ai-site`, the target
   Hosting site and both deployed functions.
4. Confirm the required Secret Manager bindings exist without displaying their
   values: `VIDEO_LAB_RUNTIME_API_KEY`,
   `VIDEO_DEPLOY_STUDIO_API_TOKEN`, and `DIRECTOR_MEMORY_API_TOKEN`.
5. Confirm the deployed non-secret environment configuration still points only
   to the approved Deploy Studio stable API, not to a Lambda worker.
6. Confirm Firebase Functions Gen 2, Cloud Tasks, Firestore and Storage are the
   intended existing production services.
7. Run:

```powershell
Set-Location "E:\OneDrive\Back-up\Projects\Project_Intelligensi\Video-Lab"
pnpm install --frozen-lockfile
pnpm openapi:lint
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

8. Inspect the deploy diff. Deploy only the already-defined Video Lab resources.
   At minimum the matching application release requires both functions and
   Hosting. Include Firestore indexes/rules and Storage rules only after
   confirming the checked-in versions are the intended production versions.
9. Do not deploy a local `.env`, reveal secrets, use a worker URL in the browser,
   or enable local/mock auth in production.

After deploying:

1. Open `https://intelligensi-video-lab.web.app/videolab`.
2. Confirm authentication and `/api/v1/health` through the same origin.
3. Confirm the browser bundle and network log contain no runtime URL, provider
   address, token, object-store path or internal stack trace.
4. Submit one durable Director job and prove refresh reconnects to the same job.
5. If no paid GPU is active, expect an honest generator-unavailable state; do
   not claim inference acceptance from this smoke check.
6. Record deployed function revisions, Hosting version, source commits and smoke
   evidence.
7. Roll back immediately if authentication, ownership, same-origin routing or
   the durable Director queue regresses.

## Safety and scope boundaries

- Work directly on `main`, fetch before push, preserve colleagues' changes and
  never force-push.
- Commit and push only coherent, tested checkpoints.
- Never commit `.env` files, API keys, SSH keys, runtime URLs, prompts, models,
  generated media or private test identities.
- The Lambda API key and SSH private key are different credentials. Load each
  only into its documented server-side field. Never treat the API key file as an
  SSH key.
- Do not modify Firebase billing, payments, wallet balances or production
  runtime pins in this handover task.
- Do not promote either A16 digest without a separate explicit approval after
  the final evidence is complete.
- Do not delete either persistent model filesystem.
- Do not touch unrelated provider instances.
- Do not claim the Creator MVP complete merely because local tests or a live
  web page load.

## Completion evidence

Report:

- exact final `origin/main` commits for both repositories;
- Firebase project, Hosting release and function revisions deployed;
- CPU-safe command results;
- focused LTX 2.5 start-only result and runtime job identity stability;
- duplicate-submission/idempotency result;
- persistence, restart and byte-identical hash result;
- same-origin playback/download result;
- desktop/mobile result;
- conditional A16 LTX 2.3 result;
- actual provider cost;
- provider cleanup and baseline restoration;
- production pins remaining unchanged;
- every residual blocker, without overstating readiness.

The task is complete only when the live application contains the matching
frontend and backend release, the focused LTX 2.5 recovery path passes, the
conditional A16 LTX 2.3 acceptance passes, paid workers are terminated, and the
evidence is committed without secrets or generated media.
