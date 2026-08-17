# Minimal Creator launch runbook — 2026-08-17

## Purpose and status

This is the single implementation and operating reference for Video Lab's
minimal creator journey. It describes the intended product, the deployed
boundaries and the evidence that must exist before release. It does not replace
the OpenAPI specifications or claim that a locally passing mock is real model
acceptance.

The launch workflow is:

1. enter an everyday-language idea;
2. select video model, aspect ratio, resolution, total length and sound behaviour;
3. let the Director plan the exact deterministic storyboard;
4. review and edit scene, negative and anchor-frame directions;
5. use the Preview stage to generate or independently regenerate every opening and closing frame;
6. generate the selected scene or film only after every preview is present;
7. preserve completed work across retry, refresh and runtime restart; and
8. play or download media through authenticated same-origin routes.

`/videolab` is this minimal experience. `/storyboard/advanced` retains
reference, candidate and detailed Director controls for later progressive
disclosure. Filmmaker/Studio expansion is deferred until the minimal journey
has digest-bound paid evidence.

## Architecture and trust boundaries

```text
Authenticated browser
  -> Video Lab same-origin /api
  -> durable owner-scoped Director job
  -> Video Lab runtime adapter
  -> authenticated Deploy Studio Runtime API
  -> allow-listed LongForm lease
  -> local Gemma Director
  -> Z-Image anchors
  -> selected LTX 2.3 or LTX 2.5 workflow
  -> generated-text and media quality checks
  -> private persistent media
  -> authenticated Video Lab playback/download
```

The browser never receives a worker URL, provider hostname, runtime token,
container identifier, private storage path or internal stack trace. Video Lab
accepts opaque project, job and asset identifiers and resolves every internal
address server-side.

Video Lab owns identity-facing project state, owner checks, durable Director
jobs, idempotency, selected model and accepted media. Deploy Studio owns image
digests, runtime leases, provider lifecycle, readiness, model caches, secrets,
automatic shutdown and reconciliation. The LongForm worker owns bounded local
inference and media inspection.

## Minimal Creator input

Application code constructs the Director v2 request. Its material inputs are:

- current project ID and revision;
- original master idea and current user instruction;
- operation, such as storyboard planning or one-scene revision;
- exact scene count and current ordered shots;
- application-computed per-scene durations;
- selected `videoModel` (`ltx-2.3` or `ltx-2.5`);
- generation mode, aspect ratio and resolution;
- existing continuity bible;
- owner-authorised opaque reference summaries;
- active runtime capabilities and allow-listed controls;
- project audio policy;
- generated-text policy;
- bounded candidate count; and
- targeted scene number when revising one scene.

The minimal Creator divides a requested total length of 1–24 seconds into the
smallest balanced storyboard of at most three 1–8 second scenes. Gemma cannot
change this cardinality, order or duration. Once successful media exists, the
minimal editor blocks a duration change that would silently remap it.

## Director output and authority

Gemma returns a strict `StoryboardEnhancementResponse` containing:

- polished master prompt;
- one bounded project-wide negative prompt;
- continuity bible;
- reference-usage plan and safe visual-reference analysis;
- assumptions;
- exactly the requested ordered shots;
- title and narrative purpose for each shot;
- LTX prompt;
- first- and last-frame prompts;
- continuity notes;
- selected reference IDs and supported controls;
- explicit audio intent;
- explicit generated-text intent;
- bounded candidate-variation directions; and
- Director, enhancer, frame-prompt and instruction-bundle versions.

Video Lab rejects wrong cardinality, duplicate or missing scene numbers,
unknown references, unsupported controls, forbidden visible-text intent, empty
required prompts and unexpected schema fields. One bounded structured-output
repair is permitted; persistent invalid output fails honestly.

The Director's negative prompt can add project-specific artefacts and visual
contradictions to avoid. It cannot remove the application-owned generated-text
exclusions that are appended before Z-Image or LTX submission.

Gemma is creative and advisory. Application code remains authoritative for
authentication, ownership, entitlements, scene count/order/duration, model
selection, runtime capabilities, negative constraints, policy, queueing,
idempotency, cost controls, persistence and provider lifecycle. Prompts cannot
change those decisions.

## Semantic Director memory

Semantic memory is optional, server-only and feature-flagged. Retrieval is
owner/project scoped, bounded and sanitized. Only approved memory is formatted
into Director context. Candidate writes are separately gated.

Memory is advisory. It cannot override the user's current request, accepted
project state, scene count or order, references, audio or generated-text policy,
runtime capabilities, model selection or Video Lab validation. Retrieval may
degrade to no memory unless an operator deliberately enables fail-closed
retrieval. No memory service token, private memory content or internal endpoint
may reach the browser.

See `docs/handover/director-agent-semantic-memory-codex-brief.md` and Deploy
Studio's `docs/director-memory-gcp.md` for the service contract and operations.

## LTX engine selection

| Behaviour | LTX 2.3 | LTX 2.5 Preview |
| --- | --- | --- |
| Product status | Compatibility default with accepted historical evidence | Preview; requires its own approved digest and paid evidence |
| Runtime selection | Allow-listed capability ID `ltx-2.3` | Allow-listed capability ID `ltx-2.5` |
| Supported launch modes | Text, start frame and start/end frame where advertised | Text, start frame and start/end frame where advertised |
| Negative-prompt workflow input | CLIP node `267:247` | Workflow node `5509` |
| Fallback | Never silently changes model | Never silently falls back to 2.3 |

The UI enables a model only when the assigned managed runtime advertises that
exact capability as available. Existing rendered projects remain pinned; a
model change cannot silently reinterpret accepted outputs.

## Unwanted captions and generated text

The minimal Creator always uses `generatedTextPolicy.mode = forbidden` with:

- captions, subtitles and closed captions disabled;
- title cards and text overlays disabled;
- logos and watermarks disabled; and
- readable signage avoided.

Enforcement is layered:

1. the Director must return `generatedTextIntent.mode = none` and no visible
   text for every scene;
2. application-owned exclusions are merged into the negative prompt;
3. Z-Image receives the constraint through its positive conditioning because
   its packaged workflow has zeroed negative conditioning;
4. LTX 2.3 receives the resolved negative prompt at node `267:247`;
5. LTX 2.5 receives it at node `5509`;
6. subtitle, data and attachment streams are removed or rejected;
7. Tesseract samples the first, final and bounded periodic video frames;
8. high-confidence visible text or a forbidden stream rejects the candidate;
9. the runtime may perform only the configured bounded rerolls; and
10. Video Lab refuses to fetch, store or settle an output unless its
    `generated_text_policy` quality check explicitly passed.

Low-confidence OCR remains advisory; it must not leak recognized private text
to normal logs or browser responses. User-uploaded anchors are user-authored
inputs and do not receive a false claim of OCR approval, but a generated video
conditioned on them is still inspected. An explicit future on-screen-text mode
requires a separately reviewed advanced policy and is not available in the
minimal Creator.

## Audio policy

The default is **Only when requested**. Cinematic, dramatic or emotional prose
does not imply music. Visible instruments do not imply sound unless performance
is unambiguous. Quoted dialogue or explicit `[DIALOGUE:]`, `[MUSIC:]`, `[SFX:]`
or `[AMBIENCE:]` markers can express sound intent when the project policy
permits it.

Silent mode is deterministic: dialogue, effects, ambience and music are off,
source audio is not preserved and output muxing must contain no audio stream.
The Director proposes intent, but application/runtime code enforces the final
stream policy.

## Seeds, scenes and persistence

The project stores a global seed and explicit per-scene seeds. Minimal scene
planning deterministically derives stable seeds for newly created scenes. Seeds
are application data, not Gemma decisions. A targeted scene or anchor retry
must not mutate another scene's prompt, seed, media or accepted generation.

Successful anchors and videos remain accessible while replacements run. Failed
replacements do not destroy the prior version. Project reopen and runtime
restart recovery must preserve accepted IDs and media hashes without
resubmitting completed paid work.

## Runtime API and asynchronous Director jobs

`contracts/video-lab.openapi.yaml` defines Video Lab's public same-origin API.
Deploy Studio's `docs/intelligensi-runtime-api.openapi.yaml` defines the stable
runtime boundary. Generated clients and contract tests must remain synchronized
with both documents.

Director inference uses submit-and-poll jobs. The browser submits an
owner-scoped job, receives a safe opaque ID and polls short status requests for
queued, model-loading, planning, validating and terminal states. Do not route a
multi-minute Gemma request through one Firebase Hosting rewrite. Firebase
deployment and hosted-job infrastructure remain John's platform boundary.

## Local setup and verification

Install dependencies from the repository root and keep all runtime credentials
server-side:

```bash
pnpm install
pnpm dev
```

For a real managed-runtime development API, configure the server process with:

```text
VIDEO_RUNTIME_PROVIDER=intelligensi-api
VIDEO_RUNTIME_BASE_URL=<approved Deploy Studio gateway origin>
VIDEO_LAB_RUNTIME_API_KEY=<server-side service credential>
VIDEO_RUNTIME_ID=longform-ltx-storyboard-studio
VIDEO_RUNTIME_PAYLOAD_MODE=deploy-studio
VIDEO_RUNTIME_ALLOW_ENV_FALLBACK=false
```

Run the complete CPU-safe boundary before proposing paid work:

```bash
pnpm lint
pnpm typecheck
pnpm openapi:lint
pnpm test
pnpm test:rules
pnpm test:e2e
pnpm build
```

Mock output proves UI, schema and state behaviour only. It is never Gemma,
Z-Image, LTX or caption-control acceptance.

## Paid acceptance procedure

Paid acceptance requires separately approved immutable candidates for both
LTX 2.3 and LTX 2.5. Follow Deploy Studio's
`docs/runtime-validation/longform-minimal-creator-paid-acceptance-plan-2026-08-17.md`.

The evidence matrix runs four sequential, unrelated creator cases, including a
dialogue-heavy caption regression and a state-leakage probe. It verifies exact
Director output, first/last anchors, independent regeneration, two-second
anchored video, explicit text-policy evidence, stream layout, persistence,
hashes, restart recovery, same-origin delivery, owner isolation, idempotency,
browser behaviour and provider cleanup. The next case starts only after the
prior case completes, and all earlier artifact hashes are rechecked.

Every paid gate must state the immutable digest, region, filesystem, GPU,
current price, maximum duration/cost, shutdown deadline and cleanup procedure.
No production pin changes as a side effect of acceptance.

## Known limitations and deferred work

- Current source changes have CPU-safe evidence but still require new immutable
  LTX 2.3 and LTX 2.5 images plus paid model evidence.
- LTX 2.5 remains Preview until its own candidate passes and is separately
  approved for promotion.
- OCR is a bounded practical safeguard, not a semantic guarantee that every
  stylized glyph will be detected.
- There is no general semantic evaluator for identity, anatomy, prompt
  adherence or flicker in the minimal launch gate.
- Direct generated on-screen text is intentionally unsupported.
- Filmmaker/Studio, advanced reference controls and broader finishing tools are
  deferred and must not complicate the launch journey.

John owns production Firebase Authentication/session deployment, Hosting and
Cloud Tasks configuration, Firestore/Storage rules and indexes, distributed
rate limiting, payments/wallets/entitlements, production quotas and commercial
retention, monitoring/alerting, DNS and public rollout. This repository must
preserve those interfaces but must not claim their production acceptance from
model tests. The current production entitlement rollout state and its
fail-closed access incident are recorded in
`docs/handover/2026-08-17-main-merge-and-entitlement-incident-to-dion.md`;
model acceptance must not bypass or silently repair that separate boundary.

## Release decision

The minimal Creator can be described as technically accepted only when both
new digest-bound candidates have their required paid evidence, every artifact
passes the generated-text boundary, earlier artifacts remain stable across the
sequential matrix, restart recovery passes, and Lambda independently reports
zero unexpected active instances. Production promotion remains a separate
explicit decision.
