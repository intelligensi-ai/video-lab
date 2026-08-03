import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, processOne } from "../../apps/api/src/index.js";
describe("api integration", () => {
  const auth = { authorization: "Bearer testuser" };
  it("grants trial once and returns me", async () => {
    const a = await request(app).get("/v1/me").set(auth).expect(200);
    const b = await request(app).get("/v1/credits").set(auth).expect(200);
    expect(a.body.uid).toBe("testuser");
    expect(b.body.available).toBeGreaterThan(0);
  });
  it("does not accept client-forged session cookies as identity", async () => {
    await request(app)
      .post("/v1/admin/runtime/pause")
      .set("Cookie", "vl_session=attacker%7Cattacker%40example.com%7C1")
      .expect(401);
    await request(app)
      .post("/v1/admin/runtime/pause")
      .set(auth)
      .set("Cookie", "vl_session=attacker%7Cattacker%40example.com%7C1")
      .expect(403);
  });
  it("completes prompts through the configured runtime adapter", async () => {
    const response = await request(app)
      .post("/v1/prompts/complete")
      .set(auth)
      .send({ prompt: "Expand this cinematic fox scene", mode: "expand" })
      .expect(200);
    expect(response.body.completedPrompt).toBe(
      "Expand this cinematic fox scene",
    );
    expect(response.body.provider).toBe("mock");
  });
  it("accepts Firebase Hosting /api-prefixed routes and keeps discovery administrator-only", async () => {
    const status = await request(app)
      .get("/api/v1/runtime/status")
      .set(auth)
      .expect(200);
    expect(status.body.provider).toBeTruthy();
    expect(status.body.baseUrl).toBeUndefined();
    expect(status.body.discovery?.baseUrl).toBeUndefined();
    await request(app)
      .post("/api/v1/admin/runtime/discover")
      .set(auth)
      .expect(403);
    await request(app)
      .post("/api/v1/admin/runtime/discover")
      .set("authorization", "Bearer admin-token")
      .expect(200);
  });
  it("lets administrators manually health-check a runtime origin before connecting it", async () => {
    await request(app)
      .post("/v1/admin/runtime/connect")
      .set(auth)
      .send({ baseUrl: "http://example.com" })
      .expect(403);
    await request(app)
      .post("/v1/admin/runtime/connect")
      .set("authorization", "Bearer admin-token")
      .send({ baseUrl: "not a url" })
      .expect(400);
    const response = await request(app)
      .post("/v1/admin/runtime/connect")
      .set("authorization", "Bearer admin-token")
      .send({ baseUrl: "http://example.com" })
      .expect(503);
    expect(response.body.code).toBe("runtime_health_failed");
  });
  it("submits idempotently, processes, and lists private gallery", async () => {
    const body = {
      prompt: "A cinematic ocean sunrise with glass monolith",
      settings: { aspectRatio: "16:9", durationSeconds: 4, quality: "draft" },
    };
    const a = await request(app)
      .post("/v1/generations")
      .set(auth)
      .set("Idempotency-Key", "same-key-123")
      .send(body)
      .expect(201);
    const b = await request(app)
      .post("/v1/generations")
      .set(auth)
      .set("Idempotency-Key", "same-key-123")
      .send(body)
      .expect(200);
    expect(b.body.id).toBe(a.body.id);
    await processOne("test");
    const g = await request(app)
      .get(`/v1/generations/${a.body.id}`)
      .set(auth)
      .expect(200);
    expect(g.body.status).toBe("completed");
    await request(app)
      .get(`/v1/generations/${a.body.id}`)
      .set({ authorization: "Bearer different-user" })
      .expect(404);
    await request(app)
      .get(`/v1/generations/${a.body.id}/download`)
      .set({ authorization: "Bearer different-user" })
      .expect(404);
    const gal = await request(app).get("/v1/gallery").set(auth).expect(200);
    expect(gal.body.items.some((x: { id: string }) => x.id === a.body.id)).toBe(
      true,
    );
  });
  it("rejects storyboard payloads above the 24-scene runtime limit", async () => {
    const response = await request(app)
      .post("/v1/generations")
      .set({ authorization: "Bearer scene-limit-user" })
      .set("Idempotency-Key", "scene-limit-123")
      .send({
        prompt: "A coherent cinematic storyboard across twenty-five scenes",
        settings: {
          aspectRatio: "16:9",
          durationSeconds: 100,
          quality: "draft",
          runtime: "longform-ltx-storyboard-studio",
          storyboard: Array.from({ length: 25 }, (_, index) => ({
            id: `scene-${index + 1}`,
          })),
        },
      })
      .expect(400);
    expect(response.body.code).toBe("scene_limit_exceeded");
  });
  it("keeps pause and kill-switch controls administrator-only", async () => {
    await request(app).post("/v1/admin/runtime/pause").set(auth).expect(403);
    await request(app)
      .post("/v1/admin/runtime/pause")
      .set("authorization", "Bearer admin-token")
      .expect(200);
    await request(app)
      .post("/v1/admin/runtime/resume")
      .set("authorization", "Bearer admin-token")
      .expect(200);
  });
  it("validates asset ownership", async () => {
    const up = await request(app)
      .post("/v1/assets/upload-url")
      .set({ authorization: "Bearer owner" })
      .send({
        fileName: "a.png",
        contentType: "image/png",
        sizeBytes: 100,
        purpose: "reference",
      })
      .expect(201);
    await request(app)
      .post("/v1/generations")
      .set({ authorization: "Bearer other" })
      .set("Idempotency-Key", "asset-key-123")
      .send({
        prompt: "A cinematic prompt that is long",
        settings: { aspectRatio: "16:9", durationSeconds: 4, quality: "draft" },
        inputAssets: [{ assetId: up.body.assetId, purpose: "reference" }],
      })
      .expect(403);
  });
});
