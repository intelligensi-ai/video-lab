# Minimal Creator launch contract — 2026-08-17

## Product decision

`/videolab` is the public-first Creator experience. It intentionally exposes
only the controls a new creator needs:

1. describe the video in everyday language;
2. choose LTX model, aspect ratio, resolution and total length;
3. ask the Director to create the storyboard;
4. review and edit scene, first-frame and last-frame directions;
5. generate and independently regenerate anchors;
6. generate, play and download the video.

References, candidate comparison, fine-grained controls and directorial chat
remain in `/storyboard/advanced`. They are not removed; they are progressive
disclosure rather than launch-critical controls.

## Deterministic Director boundary

Video Lab owns every non-creative decision. The Creator accepts a total length
of 1-24 seconds and divides it into the smallest balanced storyboard of at most
three scenes, with every scene between 1 and 8 seconds. Examples:

| Total length | Scene durations |
| --- | --- |
| 5 seconds | 5 |
| 9 seconds | 5 + 4 |
| 17 seconds | 6 + 6 + 5 |
| 24 seconds | 8 + 8 + 8 |

The Director receives that exact count and those exact durations. Gemma supplies
creative content only: the polished master direction, continuity bible, scene
title and purpose, video prompt, first/last-frame prompts, continuity handoff,
supported controls, audio intent and candidate directions. Video Lab validates
the strict response and applies all returned scenes; it does not discard every
scene after the first.

Once generated frames or videos exist, changing the total duration is blocked
in the minimal workspace. This prevents an apparently harmless setting change
from silently deleting or remapping accepted media. The advanced workflow can
make an explicit, versioned project change instead.

## Model boundary

- LTX 2.3 remains the proven default until the managed runtime advertises an
  approved compatible alternative.
- LTX 2.5 appears only when the assigned allow-listed worker advertises it.
- The browser submits the selected capability name, never an image digest,
  worker URL, provider address or access token.
- The application and Deploy Studio scheduler fail closed on a model/digest
  mismatch. There is no silent fallback from LTX 2.5 to LTX 2.3.

## No-unwanted-text contract

The minimal Creator sets `generatedTextPolicy.mode` to `forbidden` and disables
captions, subtitles, closed captions, title cards, overlays, logos and
watermarks while avoiding readable signage. The same policy crosses every
boundary:

```text
Creator form
→ Video Lab OpenAPI request
→ Director input and strict shot output
→ Deploy Studio Runtime API
→ Z-Image and selected LTX workflow
→ runtime quality report
→ Video Lab completion gate
```

The runtime must return an explicit passed `generated_text_policy` check before
Video Lab fetches, stores or settles generated output. A missing, warning or
failed check is not accepted. Existing successful media remains unchanged and
the user receives a retryable, infrastructure-safe error.

Uploaded anchors are user-authored input rather than model-generated text, so
their frame operation reports an explicit pass without claiming OCR approval.
Any final generated video using the anchor is still inspected under the project
policy.

## Local acceptance completed

The local acceptance boundary proves code and product behaviour without running
Gemma, Z-Image or LTX on the workstation:

- OpenAPI lint and generated client consistency;
- TypeScript type checking and linting;
- unit/integration regression suite;
- production web/API build;
- exact multi-scene duration planning;
- full storyboard submission rather than first-scene-only submission;
- Director result application for every scene;
- fail-closed generated-text acceptance;
- desktop and 390 × 844 mobile layout inspection with no document-level
  horizontal overflow.

The local mock runtime is not model evidence. LTX 2.5 being unavailable in a
mock session is expected and honest.

## Immutable and paid acceptance still required

Before production use, build new immutable LTX 2.3 and LTX 2.5 candidates from
the tested source and obtain digest-bound technical evidence. Then run paid
acceptance through Video Lab for both models using prompts deliberately likely
to trigger accidental typography (street scenes, storefronts and period
locations).

Required live proof:

- exact one-, two- and three-scene Director output;
- first/last anchors and independent regeneration;
- text-only, start-frame and start/end-frame modes where supported;
- visible absence of captions, title cards and readable invented signage;
- explicit runtime generated-text check in job status;
- bounded retry on a deliberately rejected candidate;
- silent-audio enforcement;
- playback/download, persistence and restart recovery;
- owner isolation, cancellation and idempotency;
- provider shutdown and independent zero-instance confirmation.

Do not promote either model solely because local tests pass.

## Ownership boundary

This work owns the creator-generation contract and model workflow. Firebase
Hosting, production authentication deployment, payments, rate limiting and the
public rollout remain separate platform work. The asynchronous Director submit
and poll path must remain the hosted boundary for inference that can exceed a
Firebase Hosting request deadline.
