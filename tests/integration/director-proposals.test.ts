import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../../apps/api/src/index.js";

const bible = Object.fromEntries([
  "characters", "wardrobe", "props", "location", "sceneGeometry", "timeOfDay",
  "lighting", "palette", "lens", "cameraPosition", "cameraMovement", "visualStyle", "audio",
].map((key) => [key, ""]));

function projectForm() {
  return {
    overallGoal: "A woman follows a teal signal into a hidden workshop.",
    originalOverallGoal: "A woman follows a light.",
    negativePrompt: "",
    resolution: "1280x720",
    fps: 24,
    imageSteps: 4,
    guidanceScale: 1,
    startFrameStrength: 1,
    endFrameStrength: 0.85,
    enhancePrompt: true,
    postProcess: "none",
    outputFormat: "mp4",
    globalVisualAnchorEnabled: false,
    globalSeed: 1337,
    seedPolicy: "global_locked",
    continuityBible: bible,
    candidateCount: 3,
    projectReferences: [{ id: "ref-mara", type: "character", label: "Mara", description: "Lead inventor", lockedTraits: ["teal raincoat"], sceneIds: [], version: 1 }],
    audioPolicy: {
      mode: "intent_only",
      dialogue: "prompted_only",
      soundEffects: "intent_only",
      ambience: "intent_only",
      music: "prompted_or_unambiguous_performance",
      preserveSourceAudio: false,
    },
    scenes: [1, 2].map((number) => ({
      id: `scene-${number}`,
      title: `Scene ${number}`,
      prompt: `A complete cinematic direction for scene ${number}.`,
      duration: 5,
      trimStart: 0,
      trimEnd: 5,
      seed: 1336 + number,
      transition: number === 1 ? "cut" : "crossfade",
      transitionDuration: 0.75,
      carryPreviousFrame: number > 1,
    })),
  };
}

async function createProject(owner: string) {
  return request(app)
    .post("/v1/storyboards/projects")
    .set("authorization", `Bearer ${owner}`)
    .send({ title: "Director project", form: projectForm() })
    .expect(201);
}

const memoryEnvKeys = [
  "DIRECTOR_MEMORY_ENABLED",
  "DIRECTOR_MEMORY_BASE_URL",
  "DIRECTOR_MEMORY_API_TOKEN",
  "DIRECTOR_MEMORY_RETRIEVAL_LIMIT",
  "DIRECTOR_MEMORY_TIMEOUT_MS",
  "DIRECTOR_MEMORY_WRITE_CANDIDATES",
  "DIRECTOR_MEMORY_REQUIRE_RETRIEVAL",
] as const;
const originalMemoryEnv = Object.fromEntries(memoryEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of memoryEnvKeys) {
    const value = originalMemoryEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function enableMemory(overrides: Record<string, string> = {}) {
  process.env.DIRECTOR_MEMORY_ENABLED = "true";
  process.env.DIRECTOR_MEMORY_BASE_URL = "https://director-memory.test";
  process.env.DIRECTOR_MEMORY_API_TOKEN = "test-memory-token";
  process.env.DIRECTOR_MEMORY_TIMEOUT_MS = "1000";
  process.env.DIRECTOR_MEMORY_RETRIEVAL_LIMIT = "6";
  process.env.DIRECTOR_MEMORY_WRITE_CANDIDATES = "false";
  process.env.DIRECTOR_MEMORY_REQUIRE_RETRIEVAL = "false";
  Object.assign(process.env, overrides);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Director proposals", () => {
  it("returns an answer without mutating the project", async () => {
    const owner = "director-answer-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "What is currently blocking this film?" })
      .expect(201);
    expect(proposal.body).toMatchObject({ kind: "answer", action: "answer_project_question", state: "pending", confirmationRequired: false });
    expect(proposal.body.diff).toEqual([]);
  });

  it("creates and applies a targeted Gemma-backed diff without changing another scene", async () => {
    const owner = "director-change-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-2", message: "Make this scene more tense without changing the other scene." })
      .expect(201);
    expect(proposal.body).toMatchObject({ kind: "draft_change", action: "propose_scene_change", executionClass: "text" });
    expect(proposal.body.diff).toHaveLength(1);
    const accepted = await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(200);
    expect(accepted.body.proposal.state).toBe("accepted");
    expect(accepted.body.project.form.scenes[0].prompt).toBe(projectForm().scenes[0].prompt);
    expect(accepted.body.project.form.scenes[1].prompt).not.toBe(projectForm().scenes[1].prompt);
    expect(accepted.body.project.form.scenes[1].prompt).toContain("scene 2");
  });

  it("continues the Improve with Director flow when memory is disabled", async () => {
    const owner = "director-memory-disabled-owner";
    const project = await createProject(owner);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Improve this scene with the Director." })
      .expect(201);
    expect(proposal.body).toMatchObject({ kind: "draft_change", action: "propose_scene_change" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retrieves approved memory and includes only safe summaries in the private Director instruction", async () => {
    enableMemory();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      schemaVersion: 1,
      degraded: false,
      items: [{
        id: "memory-1",
        scope: "project",
        category: "prompt_improvement",
        title: "Stable camera tension",
        summary: "Build tension with slower blocking and one clear camera move.",
        confidence: 0.9,
        modelTags: ["ltx-2.3"],
        embedding: [1, 2, 3],
      }],
    }));
    const owner = "director-memory-enabled-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-2", message: "Improve this scene with the Director." })
      .expect(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://director-memory.test/director-memory/retrieve");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test-memory-token" });
    const requestBody = JSON.parse(String((init as RequestInit).body));
    expect(requestBody).toMatchObject({
      ownerUid: owner,
      projectId: project.body.id,
      selectedSceneId: "scene-2",
      intent: "improve_with_director",
    });
    expect(JSON.stringify(proposal.body)).not.toContain("test-memory-token");
    expect(JSON.stringify(proposal.body)).not.toContain("director-memory.test");
    expect(JSON.stringify(proposal.body)).not.toContain("embedding");
    expect(proposal.body.diff[0].after).toContain("Stable camera tension");
    expect(proposal.body.diff[0].after).toContain("advisory only");
  });

  it("fails open on optional memory retrieval failure and blocks when retrieval is required", async () => {
    enableMemory();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network includes https://director-memory.test and token test-memory-token"));
    const owner = "director-memory-failure-owner";
    const project = await createProject(owner);
    await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Improve this scene with the Director." })
      .expect(201);

    process.env.DIRECTOR_MEMORY_REQUIRE_RETRIEVAL = "true";
    await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Improve this scene with the Director." })
      .expect(500);
  });

  it("writes a draft memory candidate after an accepted Director text proposal when enabled", async () => {
    enableMemory({ DIRECTOR_MEMORY_WRITE_CANDIDATES: "true" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/director-memory/retrieve")) return jsonResponse({ schemaVersion: 1, items: [] });
      if (String(url).endsWith("/director-memory/candidates")) return jsonResponse({ id: "candidate-1", status: "draft" });
      return jsonResponse({}, 404);
    });
    const owner = "director-memory-candidate-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Make this scene more tense." })
      .expect(201);
    await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(200);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/director-memory/candidates"))).toBe(true);
    });
    const candidateCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/director-memory/candidates"));
    const body = JSON.parse(String((candidateCall?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      scope: "project",
      ownerUid: owner,
      projectId: project.body.id,
      category: "prompt_improvement",
      title: "Director improvement accepted",
      source: { type: "video_lab_director", id: proposal.body.id },
    });
    expect(body.status).toBeUndefined();
  });

  it("rejects browser-supplied memory fields", async () => {
    const owner = "director-memory-injection-owner";
    const project = await createProject(owner);
    await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({
        projectId: project.body.id,
        selectedSceneId: "scene-1",
        message: "Improve this scene with the Director.",
        memoryItems: [{ title: "Injected" }],
        directorMemoryBaseUrl: "https://attacker.example",
      })
      .expect(400);
  });

  it("requires review for GPU work and does not create a generation merely by accepting", async () => {
    const owner = "director-generation-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Generate three draft candidates for this scene." })
      .expect(201);
    expect(proposal.body).toMatchObject({ action: "generate_scene_candidates", kind: "action_request", confirmationRequired: true, executionClass: "draft" });
    expect(proposal.body.payload.candidateCount).toBe(3);
    await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(200);
    const gallery = await request(app)
      .get("/v1/gallery")
      .set("authorization", `Bearer ${owner}`)
      .expect(200);
    expect(gallery.body.items).toHaveLength(0);
  });

  it("resolves a named project reference on the server before assignment", async () => {
    const owner = "director-reference-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-2", message: "Use reference @Mara in this scene." })
      .expect(201);
    expect(proposal.body).toMatchObject({ action: "assign_project_reference", kind: "draft_change" });
    expect(proposal.body.payload.referenceId).toBe("ref-mara");
    const accepted = await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(200);
    expect(accepted.body.project.form.scenes[0].referenceIds ?? []).toEqual([]);
    expect(accepted.body.project.form.scenes[1].referenceIds).toEqual(["ref-mara"]);
  });

  it("rejects browser mutation payloads, cross-user reads and cross-user acceptance", async () => {
    const owner = "director-security-owner";
    const project = await createProject(owner);
    await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, message: "Make the scene calmer.", upstreamUrl: "http://169.254.169.254" })
      .expect(400);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Make the scene calmer." })
      .expect(201);
    await request(app)
      .get(`/v1/storyboards/director/history?projectId=${project.body.id}`)
      .set("authorization", "Bearer director-security-other")
      .expect(404);
    await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", "Bearer director-security-other")
      .send({})
      .expect(404);
    await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", `Bearer ${owner}`)
      .send({ injectedPrompt: "replace the server patch" })
      .expect(400);
  });

  it("rejects a stale proposal after the project revision changes", async () => {
    const owner = "director-conflict-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Make this scene more restrained." })
      .expect(201);
    const changed = projectForm();
    changed.overallGoal = "The user changed the project while reviewing.";
    await request(app)
      .put(`/v1/storyboards/projects/${project.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Director project", form: changed })
      .expect(200);
    const conflict = await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(409);
    expect(conflict.body.code).toBe("project_revision_conflict");
  });

  it("removes private Director proposals when their project is deleted", async () => {
    const owner = "director-deletion-owner";
    const project = await createProject(owner);
    const proposal = await request(app)
      .post("/v1/storyboards/director/proposals")
      .set("authorization", `Bearer ${owner}`)
      .send({ projectId: project.body.id, selectedSceneId: "scene-1", message: "Make this scene calmer." })
      .expect(201);
    await request(app)
      .delete(`/v1/storyboards/projects/${project.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .expect(202);
    await request(app)
      .post(`/v1/storyboards/director/proposals/${proposal.body.id}/accept`)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(404);
  });
});
