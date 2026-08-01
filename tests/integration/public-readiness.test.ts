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

  it("does not disclose runtime instance identifiers", async () => {
    const response = await request(app)
      .get("/v1/runtime/status")
      .set("authorization", "Bearer status-user")
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain("instanceId");
    expect(["mock", "managed-longform"]).toContain(response.body.provider);
  });
});
