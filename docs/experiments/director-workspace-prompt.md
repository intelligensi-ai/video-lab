# Video Lab experimental Director workspace

> Implementation update (2026-08-04): the route is now connected to real owner-scoped projects, autosave, private references, the same-origin runtime gateway, frame replacement, candidate versions, technical QA and assembly. It is the primary `/storyboard` interface; the former editor remains at `/storyboard/classic` as a rollout recovery route, while `/experimental/director-workspace` redirects to the primary interface. The original design prompt below is retained as the product rationale. Simulated status, fabricated quality labels and static cost estimates have been removed. Model inference still requires the managed paid runtime and was not run locally.

Work in:

`E:\OneDrive\Back-up\Projects\Project_Intelligensi\Video-Lab`

Project: Experimental Video Lab Director Workspace

## Objective

Create an isolated, reviewable Video Lab interface experiment that turns the existing LongForm storyboard experience into a staged filmmaking workspace.

The experiment must preserve Video Lab's mint, cream and editorial visual identity while making the creative journey immediately understandable to someone who has never used LTX or written a cinematic prompt.

Do not replace the production `/storyboard` route during this experiment. Build the redesign at a separate temporary route so it can be evaluated before any runtime integration or migration work.

Do not change Deploy Studio, runtime contracts, payment logic, production image pins or cloud infrastructure.

## Product principle

Hide model and infrastructure mechanics. Expose creative intent.

Users should feel that they are directing a film, not operating an inference appliance. The primary workflow must not require them to understand Gemma context sizes, LTX workflow nodes, model servers, provider instances, CUDA, containers or internal storage.

## Workspace architecture

Build a compact project workspace consisting of:

- A project header containing the project name, autosave state, creator-friendly readiness, usage estimate, help and export.
- A left asset rail for characters, locations, products, props, style and voice references.
- A central canvas showing the current creative stage.
- A persistent but collapsible Gemma Director panel.
- A bottom scene filmstrip showing scene order, status, duration and selection.

Use six stages:

1. Idea
2. Cast & look
3. Storyboard
4. Frames
5. Draft videos
6. Finish

Users must be able to move backwards without losing work. Advanced controls should remain available through progressive disclosure.

## Starting experience

The Idea stage should ask, in plain language, what the user wants to create.

Include:

- Master idea.
- Format such as short film, advert, product video, social video or custom.
- Approximate duration.
- Scene count.
- Aspect ratio.
- Sound policy: Silent, Only when requested or Directed sound.
- Optional references.
- A primary `Direct my storyboard` action.

Do not show a large marketing hero inside an open project.

## Gemma Director

Present Gemma as a creative Director rather than a prompt utility.

The panel should support natural instructions such as:

- Make scene three more tense.
- Keep the lead character's coat consistent.
- Use a slower camera move.
- Remove music from the entire film.

Gemma suggestions must be reviewable. Show what would change and provide Accept, Edit and Discard actions. Never silently overwrite user-authored work.

Application code remains authoritative for schemas, scene count, ordering, identifiers, persistence, generation, ownership, cost and orchestration.

## References

Represent references as named visual assets:

- Character.
- Location.
- Product or prop.
- Style.
- Voice.

Show a thumbnail, friendly name and usage scope. Support understandable reference insertion such as `@Mara`, `@SignalLab` and `@NoirRain` in the future production implementation.

## Scene experience

Represent every scene as a compact filmstrip item and an expandable scene workspace.

The selected scene must show:

- Scene number, title, duration and status.
- Narrative purpose.
- Editable LTX video prompt.
- Equal-size first- and last-frame previews.
- The motion or camera progression between the frames.
- Editable first- and last-frame prompts.
- Independent regeneration actions.
- Previous-frame preservation during replacement.
- Stale-video messaging after prompts or anchors change.
- Assigned references.
- A single context-sensitive primary action.

The primary action should progress through Generate frames, Review frames, Generate drafts, Compare candidates, Repair selected clip and Finish scene.

## Candidate comparison

Show draft candidates side by side rather than in a long vertical stack.

Each candidate should expose:

- Playback or preview.
- Prompt version.
- Duration and resolution.
- Sound state.
- Advisory quality findings.
- Select, repair and delete actions.

Quality findings must be presented as limited, advisory checks rather than objective artistic truth.

Preserve every successful candidate in a version stack. Never overwrite an accepted result.

## Generation transparency

Before generation, show a concise usage and time estimate.

During generation, distinguish:

- Queued.
- Preparing.
- Generating.
- Finishing.
- Completed.
- Failed.

Show which scene is running, allow users to leave the page and never replace successful media with a spinner.

## Sound

Make the project sound policy visible near scene count, duration and aspect ratio:

- Silent.
- Only when requested, as the default.
- Directed sound.

Within a scene, clearly show dialogue, ambience, sound-effects and music intent. Never infer music merely from mood, genre or a visible instrument.

## Mobile requirements

Treat mobile as a dedicated composition rather than a compressed desktop layout.

Provide:

- Compact project header.
- One full-width working panel at a time.
- Bottom navigation for Story, Scenes, Assets and Director.
- Full-width prompt editing.
- Sticky primary actions where appropriate.
- Interaction targets of at least 44px.
- No global horizontal overflow.
- No overlapping headings, inputs or previews at 320px and above.

## Experimental boundary

The temporary experiment may use representative local state and simulated UI actions. It must clearly identify simulated generation so users cannot mistake the prototype for real inference.

Do not duplicate production API or runtime logic. The experiment exists to validate information architecture, visual hierarchy and interaction design before wiring it to the existing LongForm contracts.

## Acceptance

Verify at desktop and mobile sizes that:

1. A new user can identify the next action immediately.
2. The six-stage workflow is understandable.
3. References, scenes and Director guidance have distinct roles.
4. First and last frames are visually paired.
5. Prompts are editable but do not dominate the default view.
6. Candidate comparison is easy to scan.
7. Usage and time estimates appear before generation.
8. Sound behaviour is explicit.
9. Successful work remains visible during simulated replacement.
10. The mobile interface has no horizontal overflow or overlap.
11. Keyboard focus is visible and semantic controls have accessible labels.
12. The production `/storyboard` route remains unchanged.

## Deliverables

Report:

- Temporary route.
- Files changed.
- Desktop and mobile screenshots.
- Interactions demonstrated.
- Build and browser results.
- What remains prototype-only.
- Recommended production-integration order after approval.

Do not commit, push or alter production infrastructure without explicit approval.
