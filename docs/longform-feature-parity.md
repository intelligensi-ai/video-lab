# LongForm feature parity

Status meanings: **Integrated** is available through Video Lab; **Local** has deterministic local coverage; **Cloud gate** needs an approved real GPU acceptance test.

| LongForm capability                                   | Video Lab status                                                                                    | Verification                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Master-prompt enhancement                             | Integrated                                                                                          | Local API and schema tests                                       |
| Local Gemma prompt enhancer                           | Integrated through server-side Deploy Studio gateway; no paid fallback                              | Contract tests; real model is a cloud gate                       |
| Exact shot count and order                            | Integrated; application authoritative                                                               | Local tests for exact cardinality and targeted output            |
| Sequential shot prompts and continuity bible          | Integrated and editable                                                                             | Local structured mock; real Gemma quality is a cloud gate        |
| Character/location/wardrobe/lighting/style continuity | Editable continuity bible sent to enhancer/runtime                                                  | Local contract coverage; visual consistency is a cloud gate      |
| Per-shot duration                                     | Integrated, preserved during enhancement                                                            | Type/build and API validation                                    |
| Text-to-video and image-to-video                      | Existing LongForm payload preserved                                                                 | Boundary local; generation is a cloud gate                       |
| First- and last-frame generation                      | Integrated as independent jobs                                                                      | Local frame job/output tests; real image quality is a cloud gate |
| Independent frame regeneration                        | Integrated per edge                                                                                 | Local API/UI path; browser acceptance pending                    |
| Preserve previous frame on failure                    | Integrated                                                                                          | UI state review; browser failure acceptance pending              |
| Stale-video signalling after frame/prompt change      | Integrated with a visible reason                                                                    | Local state review; browser acceptance pending                   |
| Per-shot prompt editing                               | Integrated                                                                                          | Build/UI review                                                  |
| Single-shot prompt regeneration                       | Integrated; unrelated shots preserved                                                               | Local targeted regeneration test                                 |
| Whole-storyboard regeneration                         | Integrated                                                                                          | Local exact-count test                                           |
| Restore original prompt / undo enhancement            | Integrated                                                                                          | UI review                                                        |
| Manual prompt bypass                                  | Integrated; editing never requires enhancer                                                         | UI review                                                        |
| Audio/dialogue/camera/action/lighting direction       | Structured enhancer fields and prompts preserved                                                    | Real Gemma quality is a cloud gate                               |
| Draft persistence                                     | IndexedDB plus private server draft                                                                 | Local tenant-isolation test; restart browser acceptance pending  |
| Multi-project creation/history/deletion               | Not implemented; current backend persists one private draft per user and generation gallery records | Public-release gap                                               |
| Progress, cancellation and retry                      | Existing job flow preserved and gateway-safe                                                        | API tests; streaming/reconnection cloud gate                     |
| Durable production queue                              | Transactional Firestore queue, idempotency, active lock and lease                                   | Type/tests; emulator/staging acceptance pending                  |
| Final playback and download                           | Same-origin owned download                                                                          | Local response tests; real media is a cloud gate                 |
| Runtime degraded states                               | Safe public classifications without infrastructure detail                                           | Local status tests                                               |

The interface now exposes the material LongForm controls in creator language. It does not expose provider, GPU, container, Ollama, runtime-host or token terminology.
