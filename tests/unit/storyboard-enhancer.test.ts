import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeployStudioStoryboardEnhancerClient,
  assertStoryboardEnhancementContextBudget,
  mockStoryboardEnhancement,
  validateStoryboardEnhancement,
} from "../../packages/runtime-adapter/src/storyboardEnhancer.js";
import type { StoryboardEnhancementRequest, StoryboardEnhancementRuntimeContext } from "../../packages/contracts/src/index.js";

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
    generatedTextIntent: { mode: "none" as const, visibleText: [], reason: "Generated visible text is disabled." },
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
  generatedTextPolicy: {
    mode: "forbidden",
    captions: false,
    subtitles: false,
    closedCaptions: false,
    titleCards: false,
    textOverlays: false,
    logos: false,
    watermarks: false,
    signage: "avoid_readable_text",
  },
  requestedCandidateCount: 3,
};
const runtimeContext: StoryboardEnhancementRuntimeContext = {
  correlationId: "test-correlation-0001",
  visualReferences: [],
  textOnlyReferenceIds: [],
};
const directorAudioIntent = (intent: StoryboardEnhancementRequest["shots"][number]["audioIntent"]) => ({
  mode: intent.mode,
  reason: [
    intent.reason,
    intent.dialogue ? `Dialogue: ${intent.dialogue}` : "",
    intent.ambience ? `Ambience: ${intent.ambience}` : "",
    intent.soundEffects ? `Sound effects: ${intent.soundEffects}` : "",
    intent.music ? `Music: ${intent.music}` : "",
    intent.silence ? `Silence: ${intent.silence}` : "",
  ].filter(Boolean).join(" ").slice(0, 1_000),
});

describe("storyboard enhancer contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts exactly the requested ordered shots", () => {
    const result = validateStoryboardEnhancement(
      mockStoryboardEnhancement(request),
      request,
    );
    expect(result.shots.map((shot) => shot.shotNumber)).toEqual([1, 2]);
    expect(result.negativePrompt).toContain("unwanted visible text");
  });

  it("requires a bounded Director negative prompt", () => {
    const missing = { ...mockStoryboardEnhancement(request) } as Record<string, unknown>;
    delete missing.negativePrompt;
    expect(() => validateStoryboardEnhancement(missing, request)).toThrow(
      "missing required fields",
    );

    expect(() => validateStoryboardEnhancement({
      ...mockStoryboardEnhancement(request),
      negativePrompt: "x".repeat(4_001),
    }, request)).toThrow("Negative prompt");
  });

  it("keeps four sequential project prompts isolated", () => {
    const ideas = [
      "A paper boat crosses a rain-filled London gutter.",
      "A desert astronomer opens an observatory at dawn.",
      "A ceramicist shapes a blue bowl in a quiet workshop.",
      "A diver follows bioluminescent fish through a dark reef.",
    ];
    const completed = ideas.map((masterPrompt, index) => {
      const isolatedRequest: StoryboardEnhancementRequest = {
        ...request,
        projectId: `project_isolated_${index + 1}`,
        masterPrompt,
        shotCount: 1,
        shots: [{ ...request.shots[0], shotNumber: 1, prompt: masterPrompt }],
        references: [],
      };
      return validateStoryboardEnhancement(
        mockStoryboardEnhancement(isolatedRequest),
        isolatedRequest,
      );
    });

    expect(completed.map((result) => result.polishedMasterPrompt)).toEqual(ideas);
    completed.forEach((result, index) => {
      const serialized = JSON.stringify(result);
      ideas.forEach((idea, otherIndex) => {
        if (otherIndex !== index) expect(serialized).not.toContain(idea);
      });
    });
  });

  it("rejects duplicated or incorrectly ordered shots", () => {
    const invalid = mockStoryboardEnhancement(request);
    invalid.shots[1].shotNumber = 1;
    expect(() => validateStoryboardEnhancement(invalid, request)).toThrow(
      "shot order",
    );
  });

  it("rejects Director-visible text when the project policy forbids it", () => {
    const invalid = mockStoryboardEnhancement(request);
    invalid.shots[0].generatedTextIntent = {
      mode: "explicit_overlay",
      visibleText: ["London, 1666"],
      reason: "The model invented a title card.",
    };
    expect(() => validateStoryboardEnhancement(invalid, request)).toThrow(
      "project policy",
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

  it("keeps stable contract rejection distinct in server-side diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ code: "invalid_request" }),
        { status: 400, headers: { "content-type": "application/problem+json" } },
      )),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://api.intelligensi.ai",
      token: "server-only-key",
      runtimeId: "longform-ltx-storyboard-studio",
    });
    await expect(client.enhance(request, runtimeContext)).rejects.toThrow(
      "storyboard_enhancement_request_rejected",
    );
  });

  it("keeps runtime contract incompatibility distinct in server-side diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ code: "runtime_contract_incompatible" }),
        { status: 409, headers: { "content-type": "application/problem+json" } },
      )),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://api.intelligensi.ai",
      token: "server-only-key",
      runtimeId: "longform-ltx-storyboard-studio",
    });
    await expect(client.enhance(request, runtimeContext)).rejects.toThrow(
      "storyboard_enhancement_contract_incompatible",
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

  it("rejects enhancement context that cannot fit without truncation", () => {
    expect(() => assertStoryboardEnhancementContextBudget(request, runtimeContext)).not.toThrow();
    expect(() => assertStoryboardEnhancementContextBudget({
      ...request,
      masterPrompt: "x".repeat(90_000),
      shotCount: 24,
      shots: Array.from({ length: 24 }, (_, index) => ({ ...request.shots[0], shotNumber: index + 1 })),
    }, runtimeContext)).toThrow("storyboard_context_budget_exceeded");
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
          videoModel: "ltx-2.3",
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
            audioIntent: directorAudioIntent(shot.audioIntent),
            generatedTextIntent: shot.generatedTextIntent,
            carryPreviousFrame: shot.carryPreviousFrame,
            firstFrameAvailable: shot.firstFrameAvailable,
            lastFrameAvailable: shot.lastFrameAvailable,
          })),
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          references: request.references,
          availableControls: request.availableControls,
          audioPolicy: request.audioPolicy,
          generatedTextPolicy: request.generatedTextPolicy,
          requestedCandidateCount: request.requestedCandidateCount,
          correlationId: runtimeContext.correlationId,
          visualReferences: [],
          textOnlyReferenceIds: [],
        });
        return Response.json({
          ...mockStoryboardEnhancement(request),
          provider: "llama_cpp",
          model: "Bonsai-27B-Q1_0",
        });
      }),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://api.intelligensi.ai",
      token: "server-only-key",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(client.enhance(request, runtimeContext)).resolves.toMatchObject({
      provider: "llama_cpp",
      model: "Bonsai-27B-Q1_0",
      shots: [{ shotNumber: 1 }, { shotNumber: 2 }],
    });
  });

  it("flattens expanded Video Lab sound tabs for the current Director runtime contract", async () => {
    const requestWithSoundTabs: StoryboardEnhancementRequest = {
      ...request,
      shots: request.shots.map((shot, index) => ({
        ...shot,
        audioIntent: index === 0
          ? {
              mode: "dialogue",
              reason: "Use restrained production sound.",
              dialogue: "One short ancient Greek line, spoken naturally.",
              ambience: "Harbour wind and distant city activity.",
              soundEffects: "Soft rope creaks.",
              music: "",
              silence: "",
            }
          : shot.audioIntent,
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.shots[0].audioIntent).toEqual({
          mode: "dialogue",
          reason: "Use restrained production sound. Dialogue: One short ancient Greek line, spoken naturally. Ambience: Harbour wind and distant city activity. Sound effects: Soft rope creaks.",
        });
        expect(body.shots[0].audioIntent.dialogue).toBeUndefined();
        return Response.json({
          ...mockStoryboardEnhancement(requestWithSoundTabs),
          provider: "llama_cpp",
          model: "Bonsai-27B-Q1_0",
        });
      }),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://api.intelligensi.ai",
      token: "server-only-key",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(client.enhance(requestWithSoundTabs, runtimeContext)).resolves.toMatchObject({
      provider: "llama_cpp",
      shots: [{ shotNumber: 1 }, { shotNumber: 2 }],
    });
  });

  it("uses the Deploy Studio Director Agent endpoint with the compact storyboard contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://intelligensi-ai-deploy-studio.web.app/api/storyboards/enhance",
        );
        expect(init?.headers).toMatchObject({
          "content-type": "application/json",
          "X-Intelligensi-API-Key": "server-only-key",
        });
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          projectId: request.projectId,
          masterPrompt: request.masterPrompt,
          overallGoal: request.masterPrompt,
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
          })),
        });
        expect(body.contractVersion).toBeUndefined();
        expect(body.correlationId).toBeUndefined();
        expect(body.visualReferences).toBeUndefined();
        return Response.json({
          ...mockStoryboardEnhancement(request),
          provider: "llama_cpp",
          model: "Gemma Director",
        });
      }),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://intelligensi-ai-deploy-studio.web.app",
      token: "server-only-key",
      requestFormat: "deploy-studio",
      path: "/api/storyboards/enhance",
      authHeaderName: "X-Intelligensi-API-Key",
      authScheme: "none",
    });

    await expect(client.enhance(request, runtimeContext)).resolves.toMatchObject({
      provider: "llama_cpp",
      model: "Gemma Director",
      polishedMasterPrompt: request.masterPrompt,
    });
  });

  it("can authenticate the Deploy Studio Director endpoint with a Firebase bearer token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          "content-type": "application/json",
          authorization: "Bearer firebase-user-token",
        });
        expect(
          (init?.headers as Record<string, string>)["X-Intelligensi-API-Key"],
        ).toBeUndefined();
        return Response.json({
          ...mockStoryboardEnhancement(request),
          provider: "llama_cpp",
          model: "Gemma Director",
        });
      }),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://intelligensi-ai-deploy-studio.web.app",
      token: "firebase-user-token",
      requestFormat: "deploy-studio",
      path: "/api/storyboards/enhance",
      authHeaderName: "authorization",
      authScheme: "Bearer",
    });

    await expect(client.enhance(request, runtimeContext)).resolves.toMatchObject({
      provider: "llama_cpp",
      model: "Gemma Director",
    });
  });

  it("normalizes richer Deploy Studio Director responses before Video Lab validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({
        response: {
          polishedMasterPrompt: "A memory-aware cinematic plan for rainy London.",
          continuityBible: request.continuityBible,
          referenceUsagePlan: [
            { referenceId: "unknown-ref", shotNumbers: [1], purpose: "Should be removed." },
            { referenceId: "ref_character_01", shotNumbers: [1, 99], purpose: "Use the founder reference." },
          ],
          vision: {
            mode: "planning_only",
            attachedReferenceIds: ["wrong-visual-ref"],
            textOnlyReferenceIds: ["wrong-text-ref"],
          },
          shots: request.shots.map((shot) => ({
            shotNumber: shot.shotNumber,
            title: `Director scene ${shot.shotNumber}`,
            narrativePurpose: `Director purpose ${shot.shotNumber}`,
            prompt: `Director prompt ${shot.shotNumber}`,
            firstFramePrompt: `Director first frame ${shot.shotNumber}`,
            lastFramePrompt: `Director last frame ${shot.shotNumber}`,
            continuityNotes: `Director continuity ${shot.shotNumber}`,
            referenceIds: [...shot.referenceIds, "unknown-ref"],
            recommendedControls: ["start_frame", "unsupported_control"],
            audioIntent: { mode: "ambience", reason: "Rain and traffic bed." },
            renderMetadata: { seed: 1337 },
          })),
          provider: "gemini",
          model: "gemini-2.5-flash",
          renderMetadata: { fps: 24 },
        },
        memory: {
          usedCount: 1,
          items: [{ id: "memory-1", title: "Use teal continuity." }],
        },
      })),
    );
    const client = new DeployStudioStoryboardEnhancerClient({
      baseUrl: "https://intelligensi-ai-deploy-studio.web.app",
      token: "server-only-key",
      requestFormat: "deploy-studio",
      path: "/api/storyboards/enhance",
      authHeaderName: "X-Intelligensi-API-Key",
      authScheme: "none",
    });

    await expect(client.enhance(request, runtimeContext)).resolves.toMatchObject({
      provider: "llama_cpp",
      model: "gemini-2.5-flash",
      polishedMasterPrompt: "A memory-aware cinematic plan for rainy London.",
      shots: [
        {
          shotNumber: 1,
          prompt: "Director prompt 1",
          referenceIds: ["ref_character_01"],
          recommendedControls: ["start_frame"],
          candidateVariations: expect.arrayContaining([expect.stringContaining("Draft 1")]),
        },
        {
          shotNumber: 2,
          prompt: "Director prompt 2",
          referenceIds: ["ref_character_01"],
          recommendedControls: ["start_frame"],
        },
      ],
    });
  });
});
