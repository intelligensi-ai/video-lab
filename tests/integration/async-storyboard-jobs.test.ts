import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, processOne } from "../../apps/api/src/index.js";

const bible = Object.fromEntries(
  [
    "characters",
    "wardrobe",
    "props",
    "location",
    "sceneGeometry",
    "timeOfDay",
    "lighting",
    "palette",
    "lens",
    "cameraPosition",
    "cameraMovement",
    "visualStyle",
    "audio",
  ].map((key) => [key, ""]),
);

function enhancementBody(shotCount = 2) {
  return {
    contractVersion: "2",
    operation: "plan_storyboard",
    masterPrompt:
      "A mapmaker crosses London while smoke darkens the sky above the Thames.",
    shotCount,
    generationMode: "text_to_video",
    continuityBible: bible,
    shots: Array.from({ length: shotCount }, (_, index) => ({
      shotNumber: index + 1,
      title: `Shot ${index + 1}`,
      narrativePurpose: "",
      prompt: `Cinematic direction ${index + 1}`,
      firstFramePrompt: "",
      lastFramePrompt: "",
      continuityNotes: "",
      durationSeconds: 4,
      generationMode: "text_to_video",
      referenceIds: [],
      selectedControls: [],
      audioIntent: { mode: "silent", reason: "" },
      generatedTextIntent: { mode: "none", visibleText: [], reason: "Generated visible text is disabled." },
      carryPreviousFrame: index > 0,
      firstFrameAvailable: false,
      lastFrameAvailable: false,
    })),
    aspectRatio: "16:9",
    resolution: "1280x720",
    references: [],
    availableControls: [],
    audioPolicy: {
      mode: "intent_only",
      dialogue: "prompted_only",
      soundEffects: "intent_only",
      ambience: "intent_only",
      music: "prompted_or_unambiguous_performance",
      preserveSourceAudio: false,
    },
    generatedTextPolicy: {
      mode: "forbidden", captions: false, subtitles: false, closedCaptions: false,
      titleCards: false, textOverlays: false, logos: false, watermarks: false,
      signage: "avoid_readable_text",
    },
    requestedCandidateCount: 3,
  };
}

function projectForm() {
  return {
    overallGoal: "A mapmaker crosses London while smoke darkens the sky.",
    originalOverallGoal: "A mapmaker in London.",
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
    projectReferences: [],
    audioPolicy: enhancementBody().audioPolicy,
    generatedTextPolicy: enhancementBody().generatedTextPolicy,
    scenes: [1, 2].map((number) => ({
      id: `scene-${number}`,
      title: `Scene ${number}`,
      prompt: `A complete cinematic direction for scene ${number}.`,
      duration: 4,
      trimStart: 0,
      trimEnd: 4,
      seed: 1336 + number,
      transition: number === 1 ? "cut" : "crossfade",
      transitionDuration: 0.75,
      carryPreviousFrame: number > 1,
    })),
  };
}

describe("durable asynchronous storyboard jobs", () => {
  it("returns immediately, completes through the worker and replays idempotently", async () => {
    const owner = "async-enhancement-owner";
    const key = "enhancement-request-0001";
    const startedAt = Date.now();
    const submitted = await request(app)
      .post("/v1/storyboard-enhancements")
      .set("authorization", `Bearer ${owner}`)
      .set("idempotency-key", key)
      .send(enhancementBody(2))
      .expect(202);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(submitted.body).toMatchObject({
      kind: "storyboard_enhancement",
      status: "queued",
      stage: "queued",
    });
    expect(submitted.body.creatorAuthorization).toBeUndefined();

    const replay = await request(app)
      .post("/v1/storyboard-enhancements")
      .set("authorization", `Bearer ${owner}`)
      .set("idempotency-key", key)
      .send(enhancementBody(2))
      .expect(202);
    expect(replay.body.id).toBe(submitted.body.id);

    await processOne("async-enhancement-worker");
    const completed = await request(app)
      .get(`/v1/storyboard-enhancements/${submitted.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .expect(200);
    expect(completed.body).toMatchObject({
      status: "completed",
      stage: "completed",
    });
    expect(completed.body.result.shots).toHaveLength(2);
  });

  it("keeps a queued job recoverable beyond Firebase Hosting's request window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const owner = "async-hosting-window-owner";
      const key = "enhancement-hosting-window-0001";
      vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
      const submitted = await request(app)
        .post("/v1/storyboard-enhancements")
        .set("authorization", `Bearer ${owner}`)
        .set("idempotency-key", key)
        .send(enhancementBody(2))
        .expect(202);

      vi.setSystemTime(new Date("2026-08-16T12:01:05.000Z"));
      const recovered = await request(app)
        .get(`/v1/storyboard-enhancements/${submitted.body.id}`)
        .set("authorization", `Bearer ${owner}`)
        .expect(200);
      expect(recovered.body).toMatchObject({
        id: submitted.body.id,
        status: "queued",
        stage: "queued",
      });

      const replay = await request(app)
        .post("/v1/storyboard-enhancements")
        .set("authorization", `Bearer ${owner}`)
        .set("idempotency-key", key)
        .send(enhancementBody(2))
        .expect(202);
      expect(replay.body.id).toBe(submitted.body.id);

      await request(app)
        .post(`/v1/storyboard-enhancements/${submitted.body.id}/cancel`)
        .set("authorization", `Bearer ${owner}`)
        .send({})
        .expect(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for conflicting replays and cross-user status requests", async () => {
    const owner = "async-conflict-owner";
    const submitted = await request(app)
      .post("/v1/storyboard-enhancements")
      .set("authorization", `Bearer ${owner}`)
      .set("idempotency-key", "enhancement-conflict-0001")
      .send(enhancementBody(1))
      .expect(202);

    const conflict = await request(app)
      .post("/v1/storyboard-enhancements")
      .set("authorization", `Bearer ${owner}`)
      .set("idempotency-key", "enhancement-conflict-0001")
      .send(enhancementBody(5))
      .expect(409);
    expect(conflict.body.code).toBe("idempotency_conflict");

    await request(app)
      .get(`/v1/storyboard-enhancements/${submitted.body.id}`)
      .set("authorization", "Bearer another-owner")
      .expect(404);
    await request(app)
      .post(`/v1/storyboard-enhancements/${submitted.body.id}/cancel`)
      .set("authorization", "Bearer another-owner")
      .send({})
      .expect(404);
    await request(app)
      .post(`/v1/storyboard-enhancements/${submitted.body.id}/cancel`)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(200);
  });

  it("cancels a queued job idempotently without invoking the model", async () => {
    const owner = "async-cancel-owner";
    const submitted = await request(app)
      .post("/v1/storyboard-enhancements")
      .set("authorization", `Bearer ${owner}`)
      .set("idempotency-key", "enhancement-cancel-0001")
      .send(enhancementBody(2))
      .expect(202);
    const cancelPath = `/v1/storyboard-enhancements/${submitted.body.id}/cancel`;
    const cancelled = await request(app)
      .post(cancelPath)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(200);
    expect(cancelled.body.status).toBe("cancelled");
    const replay = await request(app)
      .post(cancelPath)
      .set("authorization", `Bearer ${owner}`)
      .send({})
      .expect(200);
    expect(replay.body.status).toBe("cancelled");
  });

  it("persists a Director proposal only after its asynchronous job completes", async () => {
    const owner = "async-director-owner";
    const project = await request(app)
      .post("/v1/storyboards/projects")
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Async Director project", form: projectForm() })
      .expect(201);
    const submitted = await request(app)
      .post("/v1/storyboards/director/jobs")
      .set("authorization", `Bearer ${owner}`)
      .set("idempotency-key", "director-proposal-0001")
      .send({
        projectId: project.body.id,
        selectedSceneId: "scene-2",
        message: "Make scene two more tense without changing scene one.",
      })
      .expect(202);
    expect(submitted.body.result).toBeUndefined();

    await processOne("async-director-worker");
    const completed = await request(app)
      .get(`/v1/storyboards/director/jobs/${submitted.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .expect(200);
    expect(completed.body.status).toBe("completed");
    expect(completed.body.result).toMatchObject({
      projectId: project.body.id,
      state: "pending",
      action: "propose_scene_change",
    });
    const history = await request(app)
      .get(`/v1/storyboards/director/history?projectId=${project.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .expect(200);
    expect(history.body.items.map((item: { id: string }) => item.id)).toContain(
      completed.body.result.id,
    );
  });

  it("keeps Creator planning project-wide and bypasses Advanced memory server-side", async () => {
    const previousMemory = {
      enabled: process.env.DIRECTOR_MEMORY_ENABLED,
      baseUrl: process.env.DIRECTOR_MEMORY_BASE_URL,
      token: process.env.DIRECTOR_MEMORY_API_TOKEN,
    };
    process.env.DIRECTOR_MEMORY_ENABLED = "true";
    process.env.DIRECTOR_MEMORY_BASE_URL = "https://director-memory.test";
    process.env.DIRECTOR_MEMORY_API_TOKEN = "private-test-token";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        schemaVersion: 1,
        degraded: false,
        items: [{
          id: "unrelated-project-memory",
          scope: "project",
          category: "prompt_improvement",
          title: "Love Island continuity",
          summary: "Keep the tropical villa and reality-show contestants in every scene.",
          confidence: 1,
          modelTags: ["ltx-2.3"],
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const owner = "async-creator-no-memory-owner";
      const project = await request(app)
        .post("/v1/storyboards/projects")
        .set("authorization", `Bearer ${owner}`)
        .send({ title: "Fresh Creator project", form: projectForm() })
        .expect(201);
      const submitted = await request(app)
        .post("/v1/storyboards/director/creator/jobs")
        .set("authorization", `Bearer ${owner}`)
        .set("idempotency-key", "creator-project-plan-0001")
        .send({
          projectId: project.body.id,
          message: "Plan this creative brief into exactly 2 scenes while preserving my intent.",
        })
        .expect(202);

      await processOne("async-creator-no-memory-worker");
      const completed = await request(app)
        .get(`/v1/storyboards/director/jobs/${submitted.body.id}`)
        .set("authorization", `Bearer ${owner}`)
        .expect(200);

      expect(completed.body).toMatchObject({ status: "completed", stage: "completed" });
      expect(completed.body.result.affectedSceneIds).toEqual([]);
      expect(completed.body.result.payload.sceneId).toBeUndefined();
      expect(completed.body.result.payload.enhancement.shots).toHaveLength(2);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(completed.body)).not.toContain("directorContextPolicy");
      expect(JSON.stringify(completed.body).toLowerCase()).not.toContain("love island");
      expect(JSON.stringify(completed.body).toLowerCase()).not.toContain("tropical villa");
      const accepted = await request(app)
        .post(`/v1/storyboards/director/proposals/${completed.body.result.id}/accept`)
        .set("authorization", `Bearer ${owner}`)
        .send({})
        .expect(200);
      expect(accepted.body.proposal.state).toBe("accepted");
      expect(JSON.stringify(accepted.body)).not.toContain("directorContextPolicy");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previousMemory.enabled === undefined) delete process.env.DIRECTOR_MEMORY_ENABLED;
      else process.env.DIRECTOR_MEMORY_ENABLED = previousMemory.enabled;
      if (previousMemory.baseUrl === undefined) delete process.env.DIRECTOR_MEMORY_BASE_URL;
      else process.env.DIRECTOR_MEMORY_BASE_URL = previousMemory.baseUrl;
      if (previousMemory.token === undefined) delete process.env.DIRECTOR_MEMORY_API_TOKEN;
      else process.env.DIRECTOR_MEMORY_API_TOKEN = previousMemory.token;
    }
  });

  it("keeps the Advanced Director on project-scoped memory", async () => {
    const previousMemory = {
      enabled: process.env.DIRECTOR_MEMORY_ENABLED,
      baseUrl: process.env.DIRECTOR_MEMORY_BASE_URL,
      token: process.env.DIRECTOR_MEMORY_API_TOKEN,
    };
    process.env.DIRECTOR_MEMORY_ENABLED = "true";
    process.env.DIRECTOR_MEMORY_BASE_URL = "https://director-memory.test";
    process.env.DIRECTOR_MEMORY_API_TOKEN = "private-test-token";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ schemaVersion: 1, degraded: false, items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const owner = "async-advanced-memory-owner";
      const project = await request(app)
        .post("/v1/storyboards/projects")
        .set("authorization", `Bearer ${owner}`)
        .send({ title: "Advanced memory project", form: projectForm() })
        .expect(201);
      await request(app)
        .post("/v1/storyboards/director/jobs")
        .set("authorization", `Bearer ${owner}`)
        .set("idempotency-key", "advanced-project-memory-0001")
        .send({
          projectId: project.body.id,
          selectedSceneId: "scene-2",
          message: "Improve scene two without changing scene one.",
        })
        .expect(202);

      await processOne("async-advanced-memory-worker");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
      expect(body).toMatchObject({
        ownerUid: owner,
        projectId: project.body.id,
        selectedSceneId: "scene-2",
      });
    } finally {
      fetchSpy.mockRestore();
      if (previousMemory.enabled === undefined) delete process.env.DIRECTOR_MEMORY_ENABLED;
      else process.env.DIRECTOR_MEMORY_ENABLED = previousMemory.enabled;
      if (previousMemory.baseUrl === undefined) delete process.env.DIRECTOR_MEMORY_BASE_URL;
      else process.env.DIRECTOR_MEMORY_BASE_URL = previousMemory.baseUrl;
      if (previousMemory.token === undefined) delete process.env.DIRECTOR_MEMORY_API_TOKEN;
      else process.env.DIRECTOR_MEMORY_API_TOKEN = previousMemory.token;
    }
  });

  it("does not apply a queued Director result after the project revision changes", async () => {
    const owner = "async-revision-owner";
    const project = await request(app)
      .post("/v1/storyboards/projects")
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Revision project", form: projectForm() })
      .expect(201);
    const submitted = await request(app)
      .post("/v1/storyboards/director/jobs")
      .set("authorization", `Bearer ${owner}`)
      .set("idempotency-key", "director-revision-0001")
      .send({
        projectId: project.body.id,
        selectedSceneId: "scene-2",
        message: "Make scene two more tense.",
      })
      .expect(202);
    await request(app)
      .put(`/v1/storyboards/projects/${project.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .send({ title: "Revision project updated", form: projectForm() })
      .expect(200);

    await processOne("async-revision-worker");
    const failed = await request(app)
      .get(`/v1/storyboards/director/jobs/${submitted.body.id}`)
      .set("authorization", `Bearer ${owner}`)
      .expect(200);
    expect(failed.body.status).toBe("failed");
    expect(JSON.stringify(failed.body)).not.toContain("runtime");
  });
});
