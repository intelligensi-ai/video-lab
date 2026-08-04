import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
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
      "/v1/storyboards/projects",
      "/v1/storyboards/projects/{projectId}",
      "/v1/storyboards/draft",
      "/v1/assets/upload-url",
      "/v1/assets/{assetId}/content",
      "/v1/generations",
      "/v1/generations/{generationId}",
      "/v1/generations/{generationId}/download",
      "/v1/generations/{generationId}/cancel",
      "/v1/gallery",
      "/v1/runtime/status",
      "/v1/admin/runtime/discover",
      "/v1/admin/runtime/connect",
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
    expect(
      doc.components.schemas.RuntimeDiscovery.properties.baseUrl,
    ).toBeUndefined();
    expect(doc.components.responses.Unauthorized.content).toHaveProperty(
      "application/problem+json",
    );
  });
  it("requires idempotency key on generation submission", () => {
    expect(doc.paths["/v1/generations"].post.parameters[0].required).toBe(true);
  });
  it("matches the LongForm 24-scene and safe-capability contract", () => {
    expect(
      doc.components.schemas.StoryboardEnhancementRequest.properties.shotCount
        .maximum,
    ).toBe(24);
    expect(
      doc.components.schemas.VideoSettings.properties.storyboard.maxItems,
    ).toBe(24);
    expect(
      doc.components.schemas.RuntimeStatus.properties.capabilities.$ref,
    ).toBe("#/components/schemas/RuntimeCapabilities");
  });
});

describe("Deploy Studio runtime API compatibility", () => {
  const deployContractPath =
    process.env.DEPLOY_STUDIO_RUNTIME_OPENAPI_PATH ??
    path.resolve(
      process.cwd(),
      "..",
      "Deploy Studio",
      "Intelligensi.ai-Deploy-Studio",
      "docs",
      "intelligensi-runtime-api.openapi.yaml",
    );
  const contractIt = fs.existsSync(deployContractPath) ? it : it.skip;

  contractIt("matches the authoritative LongForm gateway surface", () => {
    const runtime = YAML.parse(fs.readFileSync(deployContractPath, "utf8"));
    expect(runtime.info.version).toBe("1.3.0");
    expect(runtime.components.securitySchemes.ApiKeyAuth).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "X-Intelligensi-API-Key",
    });
    for (const endpoint of [
      "/v1/runtimes",
      "/v1/runtimes/{runtimeId}",
      "/v1/runtimes/{runtimeId}/health",
      "/v1/runtimes/{runtimeId}/capacity-demand",
      "/v1/runtimes/{runtimeId}/preview",
      "/v1/runtimes/{runtimeId}/jobs/{jobId}",
      "/v1/runtimes/{runtimeId}/jobs/{jobId}/cancel",
      "/v1/runtimes/{runtimeId}/jobs/{jobId}/output",
      "/v1/runtimes/{runtimeId}/prompt/complete",
      "/v1/runtimes/{runtimeId}/storyboards/enhance",
    ]) {
      expect(runtime.paths[endpoint]).toBeTruthy();
    }
    expect(runtime.components.schemas.Job.required).toEqual(
      expect.arrayContaining(["id", "runtimeId", "status", "createdAt", "links"]),
    );
    expect(runtime.components.schemas.RuntimeHealth.properties.features.$ref).toBe(
      "#/components/schemas/RuntimeFeatures",
    );
    expect(
      runtime.components.schemas.StoryboardEnhancementRequest.properties
        .shotCount.maximum,
    ).toBe(24);
  });
});
