import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, processOne } from "../../apps/api/src/index.js";

const emptyBible = {
  characters: "",
  wardrobe: "",
  props: "",
  location: "",
  sceneGeometry: "",
  timeOfDay: "",
  lighting: "",
  palette: "",
  lens: "",
  cameraPosition: "",
  cameraMovement: "",
  visualStyle: "",
  audio: "",
};

const projectForm = (sceneCount = 2) => ({
  overallGoal: "A private multi-scene film project",
  negativePrompt: "",
  resolution: "1024x576",
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
  continuityBible: emptyBible,
  scenes: Array.from({ length: sceneCount }, (_, index) => ({
    id: `scene-${index + 1}`,
    title: `Scene ${index + 1}`,
    prompt: `A detailed cinematic direction for scene ${index + 1}.`,
    duration: 4,
    trimStart: 0,
    trimEnd: 4,
    seed: 1337 + index,
    seedOverrideEnabled: false,
    summary: `Ending state for scene ${index + 1}.`,
    continuityOverrides: {},
    transition: index === 0 ? "cut" : "crossfade",
    transitionDuration: 0.75,
    carryPreviousFrame: index > 0,
  })),
});

describe("public runtime readiness boundaries", () => {
  it("rejects untrusted browser origins", async () => {
    const response = await request(app)
      .options("/v1/me")
      .set("Origin", "https://attacker.example")
      .set("Access-Control-Request-Method", "GET")
      .expect(403);
    expect(response.body.code).toBe("origin_forbidden");
  });

  it("returns exactly the requested structured storyboard shots", async () => {
    const response = await request(app)
      .post("/v1/storyboards/enhance")
      .set("authorization", "Bearer enhancer-user")
      .send({
        masterPrompt: "A founder follows a teal signal through rainy London.",
        shotCount: 2,
        generationMode: "text_to_video",
        continuityBible: emptyBible,
        shots: [1, 2].map((shotNumber) => ({
          shotNumber,
          title: `Shot ${shotNumber}`,
          prompt: "",
          durationSeconds: 5,
          generationMode: "text_to_video",
        })),
      })
      .expect(200);
    expect(response.body.provider).toBe("mock");
    expect(
      response.body.shots.map(
        (shot: { shotNumber: number }) => shot.shotNumber,
      ),
    ).toEqual([1, 2]);
    expect(
      response.body.shots.every(
        (shot: { firstFramePrompt: string; lastFramePrompt: string }) =>
          shot.firstFramePrompt.length > 8 && shot.lastFramePrompt.length > 8,
      ),
    ).toBe(true);
  });

  it("regenerates only the targeted shot", async () => {
    const response = await request(app)
      .post("/v1/storyboards/enhance")
      .set("authorization", "Bearer targeted-enhancer-user")
      .send({
        masterPrompt: "An intimate two-shot conversation in a quiet workshop.",
        shotCount: 3,
        generationMode: "text_to_video",
        continuityBible: emptyBible,
        shots: [1, 2, 3].map((shotNumber) => ({
          shotNumber,
          title: `Shot ${shotNumber}`,
          prompt: `Direction ${shotNumber}`,
          durationSeconds: 5,
          generationMode: "text_to_video",
        })),
        targetShotNumber: 2,
      })
      .expect(200);
    expect(response.body.shots).toHaveLength(1);
    expect(response.body.shots[0].shotNumber).toBe(2);
  });

  it("supports the runtime's complete 24-scene enhancement boundary", async () => {
    const response = await request(app)
      .post("/v1/storyboards/enhance")
      .set("authorization", "Bearer long-story-owner")
      .send({
        masterPrompt: "A generational science-fiction journey across one city.",
        shotCount: 24,
        generationMode: "text_to_video",
        continuityBible: emptyBible,
        shots: Array.from({ length: 24 }, (_, index) => ({
          shotNumber: index + 1,
          title: `Shot ${index + 1}`,
          prompt: `Story beat ${index + 1}`,
          durationSeconds: 4,
          generationMode: "text_to_video",
        })),
      })
      .expect(200);
    expect(response.body.shots).toHaveLength(24);
    expect(response.body.shots[23].shotNumber).toBe(24);
  });

  it("creates, reopens, updates and isolates owner-scoped projects", async () => {
    const created = await request(app)
      .post("/v1/storyboards/projects")
      .set("authorization", "Bearer project-owner")
      .send({ title: "Rain signal", form: projectForm() })
      .expect(201);
    expect(created.body).toMatchObject({ title: "Rain signal", sceneCount: 2 });
    const projectId = created.body.id as string;
    const other = await request(app)
      .get(`/v1/storyboards/projects/${projectId}`)
      .set("authorization", "Bearer project-other")
      .expect(404);
    expect(other.body.code).toBe("project_not_found");
    const updated = await request(app)
      .put(`/v1/storyboards/projects/${projectId}`)
      .set("authorization", "Bearer project-owner")
      .send({ title: "Rain signal revised", form: projectForm(3) })
      .expect(200);
    expect(updated.body).toMatchObject({
      id: projectId,
      title: "Rain signal revised",
      sceneCount: 3,
    });
    const listed = await request(app)
      .get("/v1/storyboards/projects")
      .set("authorization", "Bearer project-owner")
      .expect(200);
    expect(listed.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: projectId, sceneCount: 3 }),
      ]),
    );
    await request(app)
      .delete(`/v1/storyboards/projects/${projectId}`)
      .set("authorization", "Bearer project-owner")
      .expect(202);
    await request(app)
      .get(`/v1/storyboards/projects/${projectId}`)
      .set("authorization", "Bearer project-owner")
      .expect(404);
  });

  it("isolates private storyboard drafts between users", async () => {
    const form = {
      overallGoal: "A private storyboard draft",
      resolution: "1024x576",
      fps: 24,
      scenes: [
        {
          id: "scene-private",
          title: "Private scene",
          prompt: "A private scene prompt",
          duration: 5,
          trimStart: 0,
          trimEnd: 5,
          seed: 1337,
          transition: "cut",
          transitionDuration: 0.75,
          carryPreviousFrame: true,
        },
      ],
    };
    await request(app)
      .put("/v1/storyboards/draft")
      .set("authorization", "Bearer draft-owner")
      .send({ form })
      .expect(200);
    const other = await request(app)
      .get("/v1/storyboards/draft")
      .set("authorization", "Bearer draft-other")
      .expect(200);
    expect(other.body.form).toBeNull();
    const owner = await request(app)
      .get("/v1/storyboards/draft")
      .set("authorization", "Bearer draft-owner")
      .expect(200);
    expect(owner.body.form.overallGoal).toBe(form.overallGoal);
  });

  it("uploads frames through a same-origin Video Lab path", async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const target = await request(app)
      .post("/v1/assets/upload-url")
      .set("authorization", "Bearer upload-owner")
      .send({
        fileName: "opening.png",
        contentType: "image/png",
        sizeBytes: bytes.length,
        purpose: "start_frame",
      })
      .expect(201);
    expect(target.body.uploadUrl).toMatch(/^\/v1\/assets\//);
    expect(target.body.uploadUrl).not.toMatch(/^https?:/);
    expect(target.body.objectPath).toBeUndefined();
    await request(app)
      .put(target.body.uploadUrl)
      .set("authorization", "Bearer upload-owner")
      .set("content-type", "image/png")
      .send(bytes)
      .expect(204);
  });

  it("rejects an upload whose bytes do not match its declared image type", async () => {
    const bytes = Buffer.from("not-a-png");
    const target = await request(app)
      .post("/v1/assets/upload-url")
      .set("authorization", "Bearer signature-owner")
      .send({
        fileName: "fake.png",
        contentType: "image/png",
        sizeBytes: bytes.length,
        purpose: "reference",
      })
      .expect(201);
    const response = await request(app)
      .put(target.body.uploadUrl)
      .set("authorization", "Bearer signature-owner")
      .set("content-type", "image/png")
      .send(bytes)
      .expect(400);
    expect(response.body.code).toBe("invalid_asset");
  });

  it("returns an independently generated frame through the private output route", async () => {
    const submitted = await request(app)
      .post("/v1/generations")
      .set("authorization", "Bearer frame-owner")
      .set("Idempotency-Key", "frame-owner-start-1")
      .send({
        prompt: "A detailed cinematic master prompt for an opening frame",
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: 5,
          quality: "draft",
          operationScope: "start_frame",
          operationSceneId: "scene-frame",
          framePrompt:
            "A rain-dark street, wide opening composition, teal reflections and soft backlight.",
          storyboard: [{ id: "scene-frame" }],
        },
      })
      .expect(201);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await processOne("frame-test-worker");
      const current = await request(app)
        .get(`/v1/generations/${submitted.body.id}`)
        .set("authorization", "Bearer frame-owner")
        .expect(200);
      if (current.body.status === "completed") break;
    }
    const completed = await request(app)
      .get(`/v1/generations/${submitted.body.id}`)
      .set("authorization", "Bearer frame-owner")
      .expect(200);
    expect(completed.body.output).toMatchObject({
      kind: "frame",
      contentType: "image/png",
    });
    await request(app)
      .get(`/v1/generations/${submitted.body.id}/download`)
      .set("authorization", "Bearer frame-owner")
      .expect("content-type", /image\/png/)
      .expect(200);
  });

  it("queues different users independently and supports concurrent worker claims", async () => {
    const generationBody = (label: string) => ({
      prompt: `A complete cinematic generation prompt for ${label}.`,
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: "16:9",
        durationSeconds: 4,
        quality: "draft",
        operationScope: "project",
        storyboard: [
          {
            id: `scene-${label}`,
            title: `Scene ${label}`,
            prompt: `A focused cinematic scene for ${label}.`,
            duration: 4,
            trimStart: 0,
            trimEnd: 4,
            seed: 1337,
            transition: "cut",
            transitionDuration: 0.75,
            carryPreviousFrame: false,
          },
        ],
      },
      inputAssets: [],
    });
    const first = await request(app)
      .post("/v1/generations")
      .set("authorization", "Bearer concurrent-owner-a")
      .set("Idempotency-Key", "concurrent-owner-a-job")
      .send(generationBody("owner-a"))
      .expect(201);
    const second = await request(app)
      .post("/v1/generations")
      .set("authorization", "Bearer concurrent-owner-b")
      .set("Idempotency-Key", "concurrent-owner-b-job")
      .send(generationBody("owner-b"))
      .expect(201);

    expect(first.body.queuePosition).toBe(1);
    expect(second.body.queuePosition).toBe(2);
    await request(app)
      .post("/v1/generations")
      .set("authorization", "Bearer concurrent-owner-a")
      .set("Idempotency-Key", "concurrent-owner-a-second")
      .send(generationBody("owner-a-second"))
      .expect(409);
    await request(app)
      .get(`/v1/generations/${first.body.id}`)
      .set("authorization", "Bearer concurrent-owner-b")
      .expect(404);

    await Promise.all([
      processOne("concurrent-worker-a"),
      processOne("concurrent-worker-b"),
    ]);
    const [firstCompleted, secondCompleted] = await Promise.all([
      request(app)
        .get(`/v1/generations/${first.body.id}`)
        .set("authorization", "Bearer concurrent-owner-a")
        .expect(200),
      request(app)
        .get(`/v1/generations/${second.body.id}`)
        .set("authorization", "Bearer concurrent-owner-b")
        .expect(200),
    ]);
    expect(firstCompleted.body).toMatchObject({
      status: "completed",
      queuePosition: 0,
    });
    expect(secondCompleted.body).toMatchObject({
      status: "completed",
      queuePosition: 0,
    });
  }, 10_000);

  it("renders owned scenes and assembles them using only opaque public ids", async () => {
    const owner = "assembly-owner";
    const form = projectForm();
    const project = await request(app)
      .post("/v1/storyboards/projects")
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Assembly project", form })
      .expect(201);
    const sceneGenerationIds: string[] = [];
    for (const scene of form.scenes) {
      const submitted = await request(app)
        .post("/v1/generations")
        .set("authorization", `Bearer ${owner}`)
        .set("Idempotency-Key", `scene-${owner}-${scene.id}`)
        .send({
          prompt: scene.prompt,
          settings: {
            runtime: "longform-ltx-storyboard-studio",
            aspectRatio: "16:9",
            durationSeconds: scene.duration,
            quality: "draft",
            projectId: project.body.id,
            operationScope: "scene",
            operationSceneId: scene.id,
            overallGoal: form.overallGoal,
            resolution: form.resolution,
            fps: form.fps,
            seedMode: form.seedPolicy,
            baseSeed: form.globalSeed,
            storyboard: [scene],
          },
          inputAssets: [],
        })
        .expect(201);
      await processOne(`scene-worker-${scene.id}`);
      const completed = await request(app)
        .get(`/v1/generations/${submitted.body.id}`)
        .set("authorization", `Bearer ${owner}`)
        .expect(200);
      expect(completed.body.status).toBe("completed");
      expect(JSON.stringify(completed.body)).not.toContain("runtimeJobId");
      sceneGenerationIds.push(completed.body.id);
    }
    await request(app)
      .post("/v1/generations")
      .set("authorization", `Bearer ${owner}`)
      .set("Idempotency-Key", "assembly-private-id-rejected")
      .send({
        prompt: form.overallGoal,
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: 8,
          quality: "draft",
          projectId: project.body.id,
          operationScope: "assembly",
          assemblyJobIds: ["private-runtime-1", "private-runtime-2"],
          acceptedSceneGenerationIds: sceneGenerationIds,
          storyboard: form.scenes,
        },
      })
      .expect(400);
    const otherProject = await request(app)
      .post("/v1/storyboards/projects")
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Other assembly project", form })
      .expect(201);
    const otherScene = await request(app)
      .post("/v1/generations")
      .set("authorization", `Bearer ${owner}`)
      .set("Idempotency-Key", "other-project-scene")
      .send({
        prompt: form.scenes[0].prompt,
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: form.scenes[0].duration,
          quality: "draft",
          projectId: otherProject.body.id,
          operationScope: "scene",
          operationSceneId: form.scenes[0].id,
          overallGoal: form.overallGoal,
          resolution: form.resolution,
          fps: form.fps,
          seedMode: form.seedPolicy,
          baseSeed: form.globalSeed,
          storyboard: [form.scenes[0]],
        },
        inputAssets: [],
      })
      .expect(201);
    await processOne("other-project-scene-worker");
    await request(app)
      .post("/v1/generations")
      .set("authorization", `Bearer ${owner}`)
      .set("Idempotency-Key", "cross-project-assembly-rejected")
      .send({
        prompt: form.overallGoal,
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: 8,
          quality: "draft",
          projectId: project.body.id,
          operationScope: "assembly",
          acceptedSceneGenerationIds: [
            otherScene.body.id,
            sceneGenerationIds[1],
          ],
          storyboard: form.scenes,
        },
        inputAssets: [],
      })
      .expect(400);
    const submittedAssembly = await request(app)
      .post("/v1/generations")
      .set("authorization", `Bearer ${owner}`)
      .set("Idempotency-Key", "assembly-opaque-generation-ids")
      .send({
        prompt: form.overallGoal,
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: 8,
          quality: "draft",
          projectId: project.body.id,
          operationScope: "assembly",
          acceptedSceneGenerationIds: sceneGenerationIds,
          storyboard: form.scenes,
        },
        inputAssets: [],
      })
      .expect(201);
    expect(submittedAssembly.body.settings.acceptedSceneGenerationIds).toEqual(
      sceneGenerationIds,
    );
    expect(JSON.stringify(submittedAssembly.body)).not.toContain(
      "assemblyJobIds",
    );
    await processOne("assembly-worker");
    const completedAssembly = await request(app)
      .get(`/v1/generations/${submittedAssembly.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .expect(200);
    expect(completedAssembly.body).toMatchObject({
      status: "completed",
      output: { kind: "video", contentType: "video/mp4" },
    });
  }, 20_000);

  it("does not disclose runtime instance identifiers", async () => {
    const response = await request(app)
      .get("/v1/runtime/status")
      .set("authorization", "Bearer status-user")
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain("instanceId");
    expect(["mock", "managed-longform"]).toContain(response.body.provider);
  });
});
