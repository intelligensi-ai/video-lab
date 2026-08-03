# Paid LongForm runtime acceptance - 2026-08-03

## Accepted configuration

- Run: `vl-e2e-2608031348-098f40`
- Video Lab: `7b848d811d39bc4de7c5201c987859d22dc6dd30`
- Deploy Studio: `516b32a69c6fa66b330568dd5eb0522c584f5d36`
- Candidate: `sha256:2129755951882d68f4636f754422318120539666482fb0ec6509901d5f0f5145`
- GPU: Lambda H100 PCIe, `us-west-3`
- Enhancer: private Ollama `gemma4:e4b`
- Provider quote: USD 3.29/hour
- Runtime: about 35.4 minutes
- Approximate cost: USD 1.94
- Local inference: none

The 60-minute automatic-shutdown guard was armed before bootstrap. The test instance was terminated after acceptance, no unexpected active instance remained, and the provider inventory returned to its pre-test baseline.

## Passed assertions

- Direct unauthenticated worker request returned 401.
- Stable-gateway and Video Lab health became ready without exposing the runtime origin.
- Gemma returned exactly two ordered shots with complete scene, first-frame and last-frame prompts.
- Targeted prompt regeneration returned only shot 2.
- First and last frames generated independently.
- Replacing the first frame preserved the previous successful frame.
- Two authenticated users entered the FIFO at positions 1 and 2.
- A second active job for the same user was rejected.
- Cross-user project and generation reads were rejected.
- The second user cancelled their own queued job.
- The single H100 worker serialized VRAM-intensive generation.
- A real two-second, start/end-anchored LTX scene completed.
- Video Lab delivered the result as `video/mp4` through its same-origin media route.
- Stable-gateway idempotent replay returned the existing runtime job.
- Restarting the LongForm container preserved the completed output byte-for-byte.
- Runtime endpoints, tokens, provider identifiers and private storage paths were absent from Video Lab responses.

## Evidence summary

- Gemma scene prompt lengths: 119 and 139 words.
- First frame: 696,556 bytes.
- Last frame: 759,609 bytes.
- Replacement first frame: 677,610 bytes.
- Video: 441,983 bytes, two seconds, `video/mp4`.
- Restart recovery: recovered video SHA-256 matched the original.

Hashes and sizes identify the private audit artifacts without committing generated media. Raw endpoints, credentials, provider addresses, prompts and user test data are not stored in Git.

## Remaining release gates

- Explicit approval is still required before promoting the candidate digest for new production deployments.
- Accepted-scene assembly and a complete multi-scene final film were not exercised in this bounded run.
- Provider replacement with durable object-store rebinding remains unproven; this run tested a container restart on the same instance.
- True simultaneous rendering requires multiple private runtime leases or a managed warm pool. One GPU worker intentionally renders serially while accepting multiple users through the durable FIFO queue.
- Interactive in-app browser acceptance was unavailable because no controllable browser session was present. Supplemental repository Playwright desktop/mobile tests passed, but they are not presented as interactive acceptance.
