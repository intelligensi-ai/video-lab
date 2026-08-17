# Director Agent semantic memory Codex brief

Use this brief to run Codex against Deploy Studio first and Video Lab second.

## Objective

Create a GCP-backed semantic memory layer for the Director Agent so prompt
improvements, generation issues, QA findings and accepted production lessons can
be retrieved safely during future Director planning.

The implementation must preserve the existing product boundary:

```text
Browser
  -> authenticated Video Lab API
  -> owner/project validation
  -> Director memory retrieval
  -> Deploy Studio runtime orchestration
  -> private Gemma/Z-Image/LTX prompt assembly
  -> private output storage
```

The browser must never receive raw embeddings, service credentials, provider
URLs, runtime API tokens, assembled system prompts, or private memory outside
the current user's authorised scope.

## Current baseline

Video Lab already has:

- A primary Director workspace at `/storyboard`.
- Server-owned Director proposal creation, acceptance and discard.
- Four proposal classes: `answer`, `suggestion`, `draft_change` and
  `action_request`.
- Reviewable text diffs for prompt changes.
- Confirmation-required GPU/runtime actions.
- Owner-scoped Director proposal history.
- Rejection of browser-authored patches, upstream URLs and cross-user proposal
  access.
- Firestore-backed private projects, runtime leases, queue records and
  operational metadata.

Deploy Studio already owns runtime lifecycle and should remain the operational
control plane for runtime discovery, worker startup, health, leases and future
GCP setup.

## Required run order

1. Run Codex in the Deploy Studio repository first.
2. Implement the GCP memory orchestration, service contract, environment
   variables, health reporting and local tests there.
3. Do not deploy production resources until explicitly approved.
4. Then run Codex in the Video Lab repository.
5. Integrate Video Lab with the Deploy Studio memory contract behind feature
   flags.
6. Preserve all existing Video Lab API and security invariants.

## GCP account and project

Use the `develop@intelligensi.ai` Google account.

Default project:

```text
intelligensi-ai-site
```

Before making cloud changes, Deploy Studio must verify:

- the active authenticated account is `develop@intelligensi.ai`;
- the active GCP project is `intelligensi-ai-site`;
- required APIs are available or can be enabled;
- service accounts and IAM roles are least-privilege;
- no browser Firebase config or API key is used as an administrative credential.

Prefer Application Default Credentials or attached service-account identity over
long-lived service-account key files.

## Deploy Studio work

Implement a small Director memory orchestration module/service owned by Deploy
Studio.

It should support:

- local emulator mode;
- production GCP mode;
- Firestore canonical memory storage;
- vector embedding/indexing adapter;
- semantic retrieval adapter;
- health/status publishing;
- migration/setup command;
- dry-run mode;
- redacted logs.

### Deploy Studio responsibilities

Deploy Studio should:

1. Validate GCP account and project.
2. Enable or check required GCP APIs.
3. Create or document service accounts:
   - `director-memory-api`;
   - `director-memory-indexer`, if indexing is separated;
   - `deploy-studio-runtime-publisher`, if not already present.
4. Configure IAM using least privilege.
5. Create or validate Firestore collections and indexes.
6. Create or validate vector-search infrastructure.
7. Expose memory health in Deploy Studio.
8. Provide environment variables for Video Lab.
9. Provide a redacted example memory record.
10. Provide tests for all contract behaviour.

### Suggested GCP services

Use:

- Firestore for canonical memory records, event records and review state.
- Vertex AI embeddings, Gemini embeddings, Firestore vector search, or Vertex AI
  Vector Search for semantic retrieval.
- Secret Manager only for ordinary application secrets; do not store
  service-account keys when workload identity or ADC can be used.
- Cloud Run only if a separate Director Memory API is preferable to embedding
  the module inside an existing Deploy Studio service.

Codex should verify the current Google Cloud product details from official GCP
documentation before implementation because vector and agent tooling changes
over time.

## Memory data model

Canonical records should be structured, auditable and reviewable.

Suggested Firestore collection:

```text
directorMemories/{memoryId}
```

Suggested shape:

```json
{
  "schemaVersion": 1,
  "scope": "global",
  "ownerUid": null,
  "projectId": null,
  "category": "prompt_improvement",
  "title": "LTX prompt order improves continuity",
  "summary": "Describe subject, visible action, camera move, lighting and continuity locks in a stable order.",
  "source": {
    "type": "director_proposal",
    "id": "proposal_123"
  },
  "status": "approved",
  "confidence": 0.82,
  "modelTags": ["gemma-director", "z-image-turbo", "ltx-2.3"],
  "embeddingModel": "configured embedding model name",
  "embedding": "provider-specific vector or external vector id",
  "createdBy": "system-or-user-id",
  "createdAt": "server timestamp",
  "updatedAt": "server timestamp",
  "deprecatedAt": null
}
```

Allowed `scope` values:

- `global`
- `model`
- `user`
- `project`
- `incident`

Allowed `category` values:

- `prompt_improvement`
- `prompt_regression`
- `generation_issue`
- `qa_finding`
- `model_limit`
- `reference_rule`
- `continuity_rule`
- `sound_rule`
- `runtime_incident`
- `acceptance_evidence`

Allowed `status` values:

- `draft`
- `approved`
- `deprecated`
- `rejected`

Only `approved` records may be retrieved for production Director prompt
assembly.

## Retrieval contract

Deploy Studio should expose a stable server-to-server contract for Video Lab.
Exact transport can be HTTP, internal module, or Firestore-backed adapter, but
the contract should behave like this:

```http
POST /director-memory/retrieve
```

Request:

```json
{
  "schemaVersion": 1,
  "ownerUid": "user-id",
  "projectId": "project-id",
  "selectedSceneId": "scene-id",
  "intent": "propose_scene_change",
  "query": "Make this scene more tense without changing the other scene.",
  "modelTags": ["gemma-director", "ltx-2.3"],
  "limit": 6
}
```

Response:

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "memory-id",
      "scope": "global",
      "category": "prompt_improvement",
      "title": "Stable prompt ordering improves LTX continuity",
      "summary": "Use subject, action, camera, lighting and continuity locks in a stable order.",
      "confidence": 0.82,
      "modelTags": ["ltx-2.3"]
    }
  ]
}
```

The response must contain short, safe summaries only. It must not return raw
source transcripts, private unrelated project data, raw embeddings or internal
prompt bundles.

## Memory write contract

Deploy Studio should support creating memory candidates from Video Lab events.

```http
POST /director-memory/candidates
```

Candidate sources:

- accepted Director proposal;
- discarded proposal with reason;
- failed generation;
- QA finding;
- runtime incident;
- paid acceptance evidence;
- manually authored admin note.

New candidates should default to `draft` unless the source is low-risk and the
auto-approval rule is explicit, tested and documented.

## Video Lab work

After Deploy Studio has the memory contract, update Video Lab.

Video Lab should:

1. Add feature flags for Director memory retrieval and memory candidate writes.
2. Retrieve approved memory during Director proposal creation.
3. Include only safe memory summaries in the server-side Director context.
4. Never expose raw memory internals to the browser.
5. Store references from proposals/generations back as memory candidates.
6. Preserve stale proposal rejection and owner-scoped access.
7. Add tests proving cross-user memory isolation.
8. Add tests proving browser-supplied memory or embedding fields are rejected.

Suggested environment variables:

```text
DIRECTOR_MEMORY_ENABLED=false
DIRECTOR_MEMORY_BASE_URL=
DIRECTOR_MEMORY_API_TOKEN=
DIRECTOR_MEMORY_RETRIEVAL_LIMIT=6
DIRECTOR_MEMORY_TIMEOUT_MS=2500
DIRECTOR_MEMORY_WRITE_CANDIDATES=false
```

If memory retrieval fails, Director proposal creation should continue without
memory unless the feature flag explicitly requires hard failure.

## Prompt assembly rule

Memory must be additive and bounded. It should guide the Director, not override
the current project.

Suggested private context section:

```text
Relevant approved Director memory:
- [prompt_improvement] Stable prompt ordering improves LTX continuity:
  Use subject, action, camera, lighting and continuity locks in a stable order.
- [sound_rule] Mood language does not authorize music:
  Only explicit music, quoted dialogue or unambiguous visible performance may
  permit generated audio when project mode is "Only when requested".
```

Do not allow memory to override:

- owner/project authorization;
- scene count;
- scene ordering;
- project sound policy;
- runtime capability labels;
- model safety limits;
- accepted user edits;
- stale proposal checks.

## Security requirements

Codex must add or preserve tests for:

- cross-user retrieval isolation;
- project-scoped retrieval isolation;
- only `approved` memory is retrieved;
- rejected/deprecated/draft memory is not used in production prompt assembly;
- browser payloads cannot inject memory records or embeddings;
- raw embeddings are never returned to browser routes;
- memory service tokens are never logged;
- runtime API tokens are never logged;
- service-account keys are not committed;
- Firestore rules deny client access to operational memory collections.

## Deploy Studio tests

Add automated tests covering:

- GCP project/account validation;
- local emulator mode;
- memory candidate creation;
- approval state transitions;
- semantic retrieval filters by scope, owner, project, status and model tags;
- degraded retrieval when embedding service is unavailable;
- no secrets in logs;
- health endpoint reports memory backend state;
- dry-run setup does not mutate cloud state.

## Video Lab tests

Add automated tests covering:

- Director proposal creation works when memory is disabled;
- Director proposal creation uses approved memory when enabled;
- Director proposal creation continues when optional memory retrieval fails;
- accepted proposal can create a memory candidate when enabled;
- cross-user memory is not used;
- browser cannot supply memory, embedding or upstream memory service fields;
- stale proposal conflict behaviour is unchanged.

## Delivery report

For the Deploy Studio run, report:

- files changed;
- GCP APIs required;
- service accounts and IAM roles;
- environment variables;
- local test results;
- dry-run output;
- redacted example memory record;
- whether any cloud resources were actually created.

For the Video Lab run, report:

- files changed;
- API/contract changes;
- feature flags added;
- tests run;
- security invariants verified;
- behaviour when memory is unavailable.

## Non-goals

Do not:

- deploy production resources without explicit approval;
- replace the existing Director proposal workflow;
- expose memory management directly to normal end users in the first pass;
- allow browser access to embeddings or operational memory collections;
- make memory authoritative over current project state;
- advertise unsupported LTX capabilities because memory mentions them;
- promote any runtime image or production pin as part of this work.

## Success criteria

The work is complete when:

1. Deploy Studio can configure and health-check the Director memory backend.
2. Deploy Studio can create and retrieve approved semantic memory in local tests.
3. Video Lab can retrieve safe approved memory summaries during Director
   proposal creation.
4. Video Lab can write memory candidates from accepted proposals or failures
   behind a feature flag.
5. Existing Director security and stale-proposal behaviour remains intact.
6. All new cloud-facing work is documented, tested and disabled by default until
   explicitly enabled.
