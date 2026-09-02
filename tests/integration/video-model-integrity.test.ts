import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../apps/api/src/index.js";

describe("LongForm video model integrity", () => {
  it("requires a separate project copy when a rendered project changes model", async () => {
    const owner = "rendered-project-model-owner";
    const form = {
      overallGoal: "A rendered LTX 2.3 project",
      resolution: "1024x576",
      fps: 24,
      videoModel: "ltx-2.3",
      scenes: [{
        id: "scene-rendered",
        prompt: "A rendered scene with an accepted cinematic clip.",
        duration: 4,
        acceptedVideoGenerationId: "generation-accepted",
        candidateGenerationIds: ["generation-accepted", "generation-draft"],
      }],
    };
    const created = await request(app)
      .post("/v1/storyboards/projects")
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Rendered project", form })
      .expect(201);

    const response = await request(app)
      .put(`/v1/storyboards/projects/${created.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Rendered project", form: { ...form, videoModel: "ltx-2.5" } })
      .expect(409);

    expect(response.body.code).toBe("rendered_project_model_change");
    const unchanged = await request(app)
      .get(`/v1/storyboards/projects/${created.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .expect(200);
    expect(unchanged.body.form.videoModel).toBe("ltx-2.3");
  });

  it("normalizes generation to the persisted project model", async () => {
    const owner = "project-model-owner";
    const scene = {
      id: "scene-1",
      title: "Scene 1",
      prompt: "A detailed cinematic direction for the first scene.",
      duration: 4,
      trimStart: 0,
      trimEnd: 4,
      seed: 1337,
      seedOverrideEnabled: false,
      summary: "The scene ends in stillness.",
      continuityOverrides: {},
      transition: "cut",
      transitionDuration: 0.75,
      carryPreviousFrame: false,
    };
    const form = {
      overallGoal: "A private LTX 2.5 project",
      resolution: "1024x576",
      fps: 24,
      videoModel: "ltx-2.5",
      scenes: [scene],
    };
    const created = await request(app)
      .post("/v1/storyboards/projects")
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "LTX 2.5 project", form })
      .expect(201);

    const response = await request(app)
      .post("/v1/generations")
      .set("authorization", `Bearer ${owner}`)
      .set("Idempotency-Key", "project-model-mismatch")
      .send({
        prompt: scene.prompt,
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          videoModel: "ltx-2.3",
          aspectRatio: "16:9",
          durationSeconds: scene.duration,
          quality: "draft",
          projectId: created.body.id,
          operationScope: "scene",
          operationSceneId: scene.id,
          storyboard: [scene],
        },
      })
      .expect(201);

    expect(response.body.settings.videoModel).toBe("ltx-2.5");
    expect(response.body.settings.video_model).toBe("ltx-2.5");
  });
});
