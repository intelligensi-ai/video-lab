import { describe, expect, it } from "vitest";
import request from "supertest";
import { createServer } from "node:http";
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
  it("accepts Firebase Hosting /api-prefixed routes and rejects magic admin tokens", async () => {
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
      .set("authorization", "Bearer local-admin")
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
      .set("authorization", "Bearer admin")
      .send({ baseUrl: "not a url" })
      .expect(403);
    const unhealthyRuntime = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, ready: false }));
    });
    await new Promise<void>((resolve) =>
      unhealthyRuntime.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = unhealthyRuntime.address();
      if (!address || typeof address === "string")
        throw new Error("Local health fixture did not bind a TCP port");
      const response = await request(app)
        .post("/v1/admin/runtime/connect")
        .set("authorization", "Bearer local-admin")
        .send({ baseUrl: `http://127.0.0.1:${address.port}` })
        .expect(503);
      expect(response.body.code).toBe("runtime_health_failed");
    } finally {
      await new Promise<void>((resolve, reject) =>
        unhealthyRuntime.close((error) => (error ? reject(error) : resolve())),
      );
    }
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
  it("creates an upscaled gallery generation from a completed video", async () => {
    const auth = { authorization: "Bearer upscale-user" };
    const source = await request(app)
      .post("/v1/generations")
      .set(auth)
      .set("Idempotency-Key", "upscale-source-123")
      .send({
        prompt: "A cinematic glass tower reflecting the sunrise",
        settings: { aspectRatio: "16:9", durationSeconds: 4, quality: "draft" },
      })
      .expect(201);
    await processOne("upscale-source-worker");
    const upscaled = await request(app)
      .post(`/v1/generations/${source.body.id}/upscale`)
      .set(auth)
      .set("Idempotency-Key", "upscale-target-123")
      .expect(201);
    expect(upscaled.body).toMatchObject({
      prompt: source.body.prompt,
      status: "queued",
      settings: {
        operationScope: "assembly",
        postProcess: "upscale",
        upscaleSourceGenerationId: source.body.id,
      },
    });
    await processOne("upscale-worker");
    const completed = await request(app)
      .get(`/v1/generations/${upscaled.body.id}`)
      .set(auth)
      .expect(200);
    expect(completed.body).toMatchObject({
      status: "completed",
      output: { kind: "video", contentType: "video/mp4" },
    });
  });
  it("bounds gallery queries before they reach persistence", async () => {
    for (const query of ["limit=0", "limit=-1", "limit=51", "limit=NaN", "limit=1.5", "status=unknown"]) {
      const response = await request(app)
        .get(`/v1/gallery?${query}`)
        .set(auth)
        .expect(400);
      expect(response.body.code).toBe("invalid_gallery_query");
    }
    await request(app).get("/v1/gallery?limit=50&status=completed").set(auth).expect(200);
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
      .set("authorization", "Bearer local-admin")
      .expect(200);
    await request(app)
      .post("/v1/admin/runtime/resume")
      .set("authorization", "Bearer local-admin")
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
