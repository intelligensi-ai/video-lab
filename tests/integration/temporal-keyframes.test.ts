import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../apps/api/src/index.js";

const onePixelPng = () =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

describe("intermediate temporal keyframe boundary", () => {
  it("rejects browser paths and fails closed without verified runtime evidence", async () => {
    const owner = "temporal-generation-owner";
    const bytes = onePixelPng();
    const target = await request(app)
      .post("/v1/assets/upload-url")
      .set("authorization", `Bearer ${owner}`)
      .send({
        fileName: "temporal-generation.png",
        contentType: "image/png",
        sizeBytes: bytes.length,
        purpose: "reference",
      })
      .expect(201);
    await request(app)
      .put(target.body.uploadUrl)
      .set("authorization", `Bearer ${owner}`)
      .set("content-type", "image/png")
      .send(bytes)
      .expect(204);
    const settings = {
      runtime: "longform-ltx-storyboard-studio",
      aspectRatio: "16:9",
      durationSeconds: 4,
      quality: "draft",
      operationScope: "scene",
      operationSceneId: "scene-temporal",
      storyboard: [
        {
          id: "scene-temporal",
          title: "Temporal scene",
          prompt:
            "A focused cinematic scene with one verified middle composition.",
          duration: 4,
          trimStart: 0,
          trimEnd: 4,
          seed: 1337,
          transition: "cut",
          transitionDuration: 0.75,
          carryPreviousFrame: false,
          keyframes: [
            {
              id: "middle-anchor",
              timeSeconds: 2,
              strength: 1,
              temporalKeyframeAssetId: target.body.assetId,
            },
          ],
        },
      ],
    };
    const unavailable = await request(app)
      .post("/v1/generations")
      .set("authorization", `Bearer ${owner}`)
      .set("Idempotency-Key", "temporal-generation-unavailable")
      .send({
        prompt: "A complete cinematic temporal-anchor generation request.",
        settings,
        inputAssets: [],
      })
      .expect(409);
    expect(unavailable.body.code).toBe("capability_unavailable");

    const injected = JSON.parse(JSON.stringify(settings)) as typeof settings;
    delete (injected.storyboard[0].keyframes[0] as Record<string, unknown>)
      .temporalKeyframeAssetId;
    (
      injected.storyboard[0].keyframes[0] as Record<string, unknown>
    ).temporalKeyframeObjectPath = `users/${owner}/uploads/forged.png`;
    const rejected = await request(app)
      .post("/v1/generations")
      .set("authorization", `Bearer ${owner}`)
      .set("Idempotency-Key", "temporal-generation-path-injection")
      .send({
        prompt: "A complete cinematic temporal-anchor generation request.",
        settings: injected,
        inputAssets: [],
      })
      .expect(400);
    expect(rejected.body.code).toBe("invalid_asset_reference");
  });
});
