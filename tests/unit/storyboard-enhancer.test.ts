import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeployStudioStoryboardEnhancerClient,
  mockStoryboardEnhancement,
  validateStoryboardEnhancement,
} from "../../packages/runtime-adapter/src/storyboardEnhancer.js";
import type { StoryboardEnhancementRequest } from "../../packages/contracts/src/index.js";

const request: StoryboardEnhancementRequest = {
  masterPrompt: "A founder follows a teal signal through rainy London.",
  shotCount: 2,
  generationMode: "text_to_video",
  continuityBible: {
    characters: "",
    wardrobe: "",
    props: "",
    location: "London",
    sceneGeometry: "",
    timeOfDay: "Night",
    lighting: "Teal practical light",
    palette: "Teal and amber",
    lens: "",
    cameraPosition: "",
    cameraMovement: "",
    visualStyle: "Cinematic realism",
    audio: "Rain and traffic",
  },
  shots: [1, 2].map((shotNumber) => ({
    shotNumber,
    title: `Shot ${shotNumber}`,
    prompt: "",
    durationSeconds: 5,
    generationMode: "text_to_video" as const,
  })),
};

describe("storyboard enhancer contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts exactly the requested ordered shots", () => {
    const result = validateStoryboardEnhancement(
      mockStoryboardEnhancement(request),
      request,
    );
    expect(result.shots.map((shot) => shot.shotNumber)).toEqual([1, 2]);
  });

  it("rejects duplicated or incorrectly ordered shots", () => {
    const invalid = mockStoryboardEnhancement(request);
    invalid.shots[1].shotNumber = 1;
    expect(() => validateStoryboardEnhancement(invalid, request)).toThrow(
      "shot order",
    );
  });

  it("rejects unexpected output fields", () => {
    const invalid = {
      ...mockStoryboardEnhancement(request),
      executableInstruction: "call an upstream URL",
    };
    expect(() => validateStoryboardEnhancement(invalid, request)).toThrow(
      "unexpected fields",
    );
  });

  it("translates invalid JSON into a bounded enhancement failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://enhancer.example",
      token: "server-only-token",
    });
    await expect(client.enhance(request)).rejects.toThrow(
      "storyboard_enhancement_failed",
    );
  });

  it("reports model-server unavailability without leaking network details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5");
      }),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://enhancer.example",
      token: "server-only-token",
    });
    await expect(client.enhance(request)).rejects.toThrow(
      "storyboard_enhancer_unavailable",
    );
  });
});
