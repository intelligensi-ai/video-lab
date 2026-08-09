import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeployStudioStoryboardEnhancerClient,
  mockStoryboardEnhancement,
  validateStoryboardEnhancement,
} from "../../packages/runtime-adapter/src/storyboardEnhancer.js";
import type { StoryboardEnhancementRequest } from "../../packages/contracts/src/index.js";

const request: StoryboardEnhancementRequest = {
  contractVersion: "2",
  projectId: "project_12345678",
  operation: "plan_storyboard",
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
    narrativePurpose: "",
    prompt: "",
    firstFramePrompt: "",
    lastFramePrompt: "",
    continuityNotes: "",
    durationSeconds: 5,
    generationMode: "text_to_video" as const,
    referenceIds: ["ref_character_01"],
    selectedControls: [],
    audioIntent: { mode: "silent" as const, reason: "" },
    carryPreviousFrame: shotNumber > 1,
    firstFrameAvailable: false,
    lastFrameAvailable: false,
  })),
  aspectRatio: "16:9",
  resolution: "1280x720",
  references: [{
    id: "ref_character_01",
    type: "character",
    label: "Founder",
    description: "The recurring lead.",
    lockedTraits: ["short dark hair", "charcoal coat"],
    version: 1,
    shotNumbers: [1, 2],
  }],
  availableControls: ["start_frame", "end_frame"],
  audioPolicy: {
    mode: "intent_only",
    dialogue: "prompted_only",
    soundEffects: "intent_only",
    ambience: "intent_only",
    music: "prompted_or_unambiguous_performance",
    preserveSourceAudio: false,
  },
  requestedCandidateCount: 3,
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

  it("rejects unknown references, unsupported controls and wrong candidate counts", () => {
    const unknownReference = mockStoryboardEnhancement(request);
    unknownReference.shots[0].referenceIds = ["ref_unknown_01"];
    expect(() => validateStoryboardEnhancement(unknownReference, request)).toThrow("unknown reference");

    const unsupportedControl = mockStoryboardEnhancement(request);
    unsupportedControl.shots[0].recommendedControls = ["launch_gpu"];
    expect(() => validateStoryboardEnhancement(unsupportedControl, request)).toThrow("unsupported control");

    const wrongCandidates = mockStoryboardEnhancement(request);
    wrongCandidates.shots[0].candidateVariations.pop();
    expect(() => validateStoryboardEnhancement(wrongCandidates, request)).toThrow("candidate count");
  });

  it("rejects legacy gateway responses without an explicit contract version", () => {
    const enhancement = mockStoryboardEnhancement(request);
    const stableResponse = {
      polishedMasterPrompt: enhancement.polishedMasterPrompt,
      continuityBible: enhancement.continuityBible,
      shots: enhancement.shots.map((shot) => ({
        shotNumber: shot.shotNumber,
        title: shot.title,
        narrativePurpose: shot.narrativePurpose,
        prompt: shot.prompt,
        firstFramePrompt: shot.firstFramePrompt,
        lastFramePrompt: shot.lastFramePrompt,
        continuityNotes: shot.continuityNotes,
      })),
      provider: enhancement.provider,
      model: enhancement.model,
    };

    expect(() => validateStoryboardEnhancement(stableResponse, request)).toThrow("contract version");
  });

  it("rejects paid external inference providers from the stable gateway", () => {
    const enhancement = mockStoryboardEnhancement(request);
    expect(() => validateStoryboardEnhancement(
      {
        ...enhancement,
        provider: "vertex-ai",
        model: "gemini-2.5-flash",
      },
      request,
    )).toThrow("unsupported");
  });

  it("uses the authenticated versioned runtime API for LongForm enhancement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://api.intelligensi.ai/v1/runtimes/longform-ltx-storyboard-studio/storyboards/enhance",
        );
        expect(init?.headers).toMatchObject({
          "content-type": "application/json",
          "X-Intelligensi-API-Key": "server-only-key",
        });
        expect(
          (init?.headers as Record<string, string>).authorization,
        ).toBeUndefined();
        expect(JSON.parse(String(init?.body))).toEqual({
          contractVersion: "2",
          operation: request.operation,
          masterPrompt: request.masterPrompt,
          shotCount: request.shotCount,
          generationMode: request.generationMode,
          continuityBible: request.continuityBible,
          shots: request.shots.map((shot) => ({
            shotNumber: shot.shotNumber,
            title: shot.title,
            narrativePurpose: shot.narrativePurpose,
            prompt: shot.prompt,
            firstFramePrompt: shot.firstFramePrompt,
            lastFramePrompt: shot.lastFramePrompt,
            continuityNotes: shot.continuityNotes,
            durationSeconds: shot.durationSeconds,
            generationMode: shot.generationMode,
            referenceIds: shot.referenceIds,
            selectedControls: shot.selectedControls,
            audioIntent: shot.audioIntent,
            carryPreviousFrame: shot.carryPreviousFrame,
            firstFrameAvailable: shot.firstFrameAvailable,
            lastFrameAvailable: shot.lastFrameAvailable,
          })),
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          references: request.references,
          availableControls: request.availableControls,
          audioPolicy: request.audioPolicy,
          requestedCandidateCount: request.requestedCandidateCount,
        });
        return Response.json({
          ...mockStoryboardEnhancement(request),
          provider: "ollama",
          model: "gemma4:e4b",
        });
      }),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://api.intelligensi.ai",
      token: "server-only-key",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(client.enhance(request)).resolves.toMatchObject({
      shots: [{ shotNumber: 1 }, { shotNumber: 2 }],
    });
  });
});
