import { describe, expect, it } from "vitest";
import fs from "node:fs";
import YAML from "yaml";
describe("openapi contract", () => {
  const doc = YAML.parse(
    fs.readFileSync("contracts/video-lab.openapi.yaml", "utf8"),
  );
  it("contains required endpoints and public states", () => {
    for (const p of [
      "/v1/health",
      "/v1/me",
      "/v1/credits",
      "/v1/prompts/complete",
      "/v1/storyboards/enhance",
      "/v1/storyboards/draft",
      "/v1/assets/upload-url",
      "/v1/assets/{assetId}/content",
      "/v1/generations",
      "/v1/generations/{generationId}",
      "/v1/generations/{generationId}/cancel",
      "/v1/gallery",
      "/v1/runtime/status",
      "/v1/admin/runtime/discover",
      "/v1/admin/runtime/pause",
      "/v1/admin/runtime/resume",
      "/v1/admin/runtime/stop",
    ])
      expect(doc.paths[p]).toBeTruthy();
    expect(doc.components.schemas.GenerationStatus.enum).toEqual([
      "queued",
      "preparing",
      "generating",
      "uploading",
      "completed",
      "failed",
      "cancelled",
    ]);
  });
  it("requires idempotency key on generation submission", () => {
    expect(doc.paths["/v1/generations"].post.parameters[0].required).toBe(true);
  });
});
