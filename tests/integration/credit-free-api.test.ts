import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../apps/api/src/index.js";

describe("credit-free generation", () => {
  it("accepts a generation without reserving or charging credits", async () => {
    const response = await request(app)
      .post("/v1/generations")
      .set({ authorization: "Bearer credit-free-user" })
      .set("Idempotency-Key", "credit-free-generation-1")
      .send({
        prompt: "A cinematic test film generated without a credit balance",
        settings: { aspectRatio: "16:9", durationSeconds: 4, quality: "draft" },
      })
      .expect(201);

    expect(response.body.creditCost).toBe(0);
    expect(response.body.creatorAuthorization).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("staging_allowlist");

    const conflict = await request(app)
      .post("/v1/generations")
      .set({ authorization: "Bearer credit-free-user" })
      .set("Idempotency-Key", "credit-free-generation-1")
      .send({
        prompt: "A different request must not reuse the same financial reservation",
        settings: { aspectRatio: "16:9", durationSeconds: 8, quality: "draft" },
      })
      .expect(409);
    expect(conflict.body.code).toBe("idempotency_conflict");
  });

  it("never returns embedded frame data in generation records", async () => {
    const response = await request(app)
      .post("/v1/generations")
      .set({ authorization: "Bearer media-persistence-user" })
      .set("Idempotency-Key", "media-persistence-generation-1")
      .send({
        prompt: "A cinematic storyboard with an uploaded opening frame",
        settings: {
          aspectRatio: "16:9",
          durationSeconds: 4,
          quality: "draft",
          globalVisualAnchorBase64: `data:image/png;base64,${"a".repeat(1_200_000)}`,
          storyboard: [
            {
              id: "scene-1",
              startFrameBase64: `data:image/png;base64,${"b".repeat(1_200_000)}`,
            },
          ],
        },
      })
      .expect(201);

    expect(JSON.stringify(response.body)).not.toContain("Base64");
    expect(JSON.stringify(response.body)).not.toContain("ObjectPath");
    expect(JSON.stringify(response.body).length).toBeLessThan(10_000);
  });

  it("rejects client-supplied private object paths", async () => {
    const response = await request(app)
      .post("/v1/generations")
      .set({ authorization: "Bearer object-path-user" })
      .set("Idempotency-Key", "object-path-generation-1")
      .send({
        prompt: "A client attempts to choose a private storage path",
        settings: {
          aspectRatio: "16:9",
          durationSeconds: 4,
          quality: "draft",
          startFrameObjectPath: "users/object-path-user/uploads/guessed.png",
        },
      })
      .expect(400);
    expect(response.body.code).toBe("invalid_asset_reference");
  });
});
