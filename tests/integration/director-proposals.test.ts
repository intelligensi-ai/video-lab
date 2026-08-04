import { describe, expect, it } from "vitest";
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
