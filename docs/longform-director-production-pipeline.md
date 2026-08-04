# LongForm Director and production-quality pipeline

Status: local CPU-safe implementation complete; real model acceptance pending an approved paid runtime.

## Boundary

```text
Browser
  -> authenticated Video Lab same-origin API
  -> owner/project/job validation
  -> Deploy Studio Runtime API 1.3
  -> allow-listed LongForm worker
  -> Gemma Director, Z-Image frames and LTX 2.3 video
  -> private output storage
  -> authenticated Video Lab media routes
```

Provider addresses, runtime credentials, storage paths, embeddings and assembled system prompts never form part of the browser contract.

## Implemented creator workflow

1. Store owner-scoped character, location, product, style, voice or motion references on a project. Image media is private and same-origin; voice and motion are descriptive planning references until a verified conditioning workflow exists.
2. Choose `Silent`, `Only when requested` (default), or `Directed sound`.
3. Ask local Gemma to direct the exact existing scene count. The schema includes reference use, continuity locks, sound intent, supported controls and exactly the application-requested number of candidate directions.
4. Review and edit the master, scene, first-frame and last-frame prompts.
5. Generate or replace first and last frame anchors independently.
6. Generate one to four draft candidates sequentially. Sequential submission preserves queue fairness and works with the existing one-active-job-per-user rule.
7. Keep every successful generation ID in the scene version stack and explicitly select the accepted draft.
8. Rank candidates by an advisory technical score covering decode, dimensions, duration, sound policy, sustained black/frozen segments and audio signal. The creator remains authoritative.
9. Assemble only one owner-authorised, accepted, non-stale scene clip per scene.

## LTX capability audit

| Capability | Current evidence | Product status |
|---|---|---|
| Text-to-video | Verified text workflow | Available |
| Start-frame conditioning | `LTXVAddGuideAdvanced`, frame index 0 | Available |
| End-frame conditioning | Second `LTXVAddGuideAdvanced`, frame index -1 | Available |
| Multiple keyframes | Only start and end are wired | Partial |
| Two-stage generation | Two sampler stages plus `LTXVLatentUpsampler` in all three verified workflows | Available in the base workflow |
| Synchronized generated audio | LTX AV latent workflow | Available subject to sound policy |
| Deterministic silence | Server-side audio-stream removal and verification | Available |
| Project reference planning | Director receives opaque, owner-authorised summaries | Available |
| Character/style reference conditioning | Runtime health explicitly reports unsupported | Planning only |
| Video/audio conditioning | No packaged verified workflow | Unavailable |
| IC-LoRA, pose, depth, edge, motion and camera LoRAs | No packaged verified workflow | Unavailable |
| Lip dubbing | No packaged verified workflow | Unavailable |
| Video-to-video modification | No packaged verified workflow | Unavailable |
| Retake | No packaged verified workflow | Unavailable |
| Extend | No packaged verified workflow | Unavailable |
| Reframe | No packaged verified workflow | Unavailable |
| Spatial finishing | The base LTX workflow includes latent upsampling; the optional UI post-process is FFmpeg scaling | Partial; avoid conflating both |
| Temporal finishing | Optional FFmpeg interpolation only | Partial |
| HDR | No packaged colour-managed HDR workflow | Unavailable |
| Candidate versions | Persisted by Video Lab, not the worker | Available |
| Quality assessment | Decode, dimensions, duration, sound policy, sustained black/frozen segments and audio signal; semantic identity/adherence/flicker evaluators are not packaged | Partial and advisory |

An API field is not treated as support. `retake`, `extend`, `reframe`, reference conditioning and HDR remain unavailable until a workflow test and generated artifact prove them.

## Director contract

The instruction bundle is split into:

- `soul.md`: identity and operating boundary.
- `enhancer.md`: LTX prompt-writing rules.
- `director.md`: reference use, continuity locks, candidate variation, control selection and conservative sound intent.

The worker reports only the Director version, Enhancer version, bundle hash and safe capability labels. Video Lab does not receive the private assembled prompt.

The application rejects wrong scene cardinality/order, unknown reference IDs, unsupported controls, invalid audio intent, unexpected fields and wrong candidate cardinality.

## Sound enforcement

`Silent` always removes the audio stream during muxing. `Only when requested` permits sound only for explicit markers, quoted dialogue, explicit audible direction, or an unambiguous performance such as a musician actively playing. Mood words and a merely visible instrument do not permit music. Explicit silence overrides all other cues.

This is enforced twice: Director instructions constrain Gemma, and deterministic runtime muxing decides whether an audio stream may be published.

## Quality limitations

The first quality contract is intentionally technical. It verifies decodability, dimensions, duration, sound-policy compliance, sustained black/frozen segments and measurable audio. It assigns a bounded 0â€“100 technical score used to rank drafts. Prompt adherence, reference similarity, anatomy, temporal flicker and final-frame compatibility are reported as `not_evaluated`, not guessed. Candidate ranking remains advisory and never deletes media.

## Paid-runtime acceptance plan

Use the current candidate source revisions, build a candidate image without moving the production digest, and launch one previously validated 80 GB worker. Arm the existing 60-minute provider shutdown before model startup.

Test one two-scene project with one character and one location reference, three sequential drafts for scene one, independent start/end frame generation, silent output, a separate explicit-music output, one selected-draft assembly and a second-user queue/isolation probe. Retake/extend/reframe must not be tested or advertised until their workflows are implemented.

The current profile estimates USD $3.29/hour, so the enforced 60-minute provider ceiling is approximately USD $3.29 plus negligible storage/egress; the intended test should terminate earlier. Record image digest, commits, GPU/region, model versions, readiness time, artifact hashes, assertions and actual cost. Terminate the provider and independently confirm zero unexpected active instances. This task did not launch that test.

## Future model benchmark

After this LTX path passes paid acceptance, use the same model-neutral Runtime API and a fixed prompt/reference set. Compare legal deployment rights, identity continuity, temporal stability, prompt adherence, sound integrity, latency, VRAM and cost. Do not alter Video Lab semantics for a model-specific shortcut.
