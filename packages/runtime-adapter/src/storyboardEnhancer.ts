import type {
  EnhancedStoryboardShot,
  StoryboardAudioIntent,
  StoryboardContinuityBible,
  StoryboardEnhancementRequest,
  StoryboardEnhancementResponse,
} from "@video-lab/contracts";

const continuityKeys: Array<keyof StoryboardContinuityBible> = [
  "characters",
  "wardrobe",
  "props",
  "location",
  "sceneGeometry",
  "timeOfDay",
  "lighting",
  "palette",
  "lens",
  "cameraPosition",
  "cameraMovement",
  "visualStyle",
  "audio",
];
const responseKeys = new Set([
  "polishedMasterPrompt",
  "continuityBible",
  "referenceUsagePlan",
  "assumptions",
  "shots",
  "provider",
  "model",
  "instructionBundle",
]);
const shotKeys = new Set([
  "shotNumber",
  "title",
  "narrativePurpose",
  "prompt",
  "firstFramePrompt",
  "lastFramePrompt",
  "continuityNotes",
  "referenceIds",
  "recommendedControls",
  "audioIntent",
  "candidateVariations",
]);
const enhancementProviders = new Set(["ollama", "mock", "vertex-ai", "gemini"]);

function runtimeApiEnhancementRequest(
  request: StoryboardEnhancementRequest,
): Record<string, unknown> {
  return {
    masterPrompt: request.masterPrompt,
    shotCount: request.shotCount,
    generationMode: request.generationMode,
    continuityBible: request.continuityBible,
    shots: request.shots.map((shot) => ({
      shotNumber: shot.shotNumber,
      title: shot.title,
      prompt: shot.prompt,
      durationSeconds: shot.durationSeconds,
      generationMode: shot.generationMode,
    })),
    ...(request.targetShotNumber === undefined
      ? {}
      : { targetShotNumber: request.targetShotNumber }),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unexpected fields`);
  }
}

function text(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${label} is empty`);
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function stringList(value: unknown, label: string, maximumItems: number, maximumLength: number) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} is invalid`);
  return value.map((entry) => text(entry, label, maximumLength));
}

export function validateStoryboardEnhancement(
  value: unknown,
  request: StoryboardEnhancementRequest,
): StoryboardEnhancementResponse {
  const root = object(value, "Storyboard enhancement");
  exactKeys(root, responseKeys, "Storyboard enhancement");
  const bible = object(root.continuityBible, "Continuity bible");
  exactKeys(bible, new Set(continuityKeys), "Continuity bible");
  const continuityBible = Object.fromEntries(
    continuityKeys.map((key) => [
      key,
      text(bible[key], `Continuity ${key}`, 4_000, true),
    ]),
  ) as unknown as StoryboardContinuityBible;
  const allowedReferenceIds = new Set((request.references ?? []).map((reference) => reference.id));
  const allowedControls = new Set(request.availableControls ?? []);
  const rawReferenceUsagePlan = root.referenceUsagePlan ?? [];
  if (!Array.isArray(rawReferenceUsagePlan)) throw new Error("Reference usage plan is invalid");
  const referenceUsagePlan = rawReferenceUsagePlan.map((entry, index) => {
    const usage = object(entry, `Reference usage ${index + 1}`);
    exactKeys(usage, new Set(["referenceId", "shotNumbers", "purpose"]), `Reference usage ${index + 1}`);
    const referenceId = text(usage.referenceId, "Reference id", 64);
    if (!allowedReferenceIds.has(referenceId)) throw new Error("Reference usage contains an unknown reference id");
    if (!Array.isArray(usage.shotNumbers) || usage.shotNumbers.some((number) => !Number.isInteger(number) || Number(number) < 1 || Number(number) > request.shotCount)) {
      throw new Error("Reference usage contains invalid shot numbers");
    }
    return { referenceId, shotNumbers: [...new Set(usage.shotNumbers as number[])], purpose: text(usage.purpose, "Reference purpose", 1_000) };
  });
  const assumptions = root.assumptions === undefined
    ? []
    : stringList(root.assumptions, "Director assumption", 24, 1_000);
  if (!Array.isArray(root.shots))
    throw new Error("Storyboard shots are invalid");
  const expectedNumbers = request.targetShotNumber
    ? [request.targetShotNumber]
    : Array.from({ length: request.shotCount }, (_, index) => index + 1);
  if (root.shots.length !== expectedNumbers.length) {
    throw new Error("Storyboard shot count does not match the request");
  }
  const shots: EnhancedStoryboardShot[] = root.shots.map((entry, index) => {
    const shot = object(entry, `Shot ${index + 1}`);
    exactKeys(shot, shotKeys, `Shot ${index + 1}`);
    if (shot.shotNumber !== expectedNumbers[index]) {
      throw new Error("Storyboard shot order does not match the request");
    }
    const referenceIds = shot.referenceIds === undefined
      ? []
      : stringList(shot.referenceIds, "Shot reference id", 16, 64);
    if (referenceIds.some((id) => !allowedReferenceIds.has(id))) throw new Error("Shot contains an unknown reference id");
    const recommendedControls = shot.recommendedControls === undefined
      ? []
      : stringList(shot.recommendedControls, "Shot control", 16, 64);
    if (recommendedControls.some((control) => !allowedControls.has(control))) throw new Error("Shot contains an unsupported control");
    const rawAudioIntent = shot.audioIntent === undefined
      ? { mode: "silent", reason: "No explicit audio direction was returned by the runtime." }
      : object(shot.audioIntent, "Shot audio intent");
    exactKeys(rawAudioIntent, new Set(["mode", "reason"]), "Shot audio intent");
    const audioMode = String(rawAudioIntent.mode) as StoryboardAudioIntent["mode"];
    if (!["silent", "dialogue", "ambience", "sound_effects", "music", "mixed"].includes(audioMode)) throw new Error("Shot audio intent is invalid");
    const candidateVariations = shot.candidateVariations === undefined
      ? Array.from({ length: request.requestedCandidateCount ?? 3 }, () => text(shot.prompt, "Shot prompt", 12_000))
      : stringList(shot.candidateVariations, "Candidate variation", 4, 2_000);
    if (candidateVariations.length !== (request.requestedCandidateCount ?? 3)) throw new Error("Shot candidate count does not match the request");
    return {
      shotNumber: expectedNumbers[index],
      title: text(shot.title, "Shot title", 160),
      narrativePurpose: text(shot.narrativePurpose, "Narrative purpose", 1_000),
      prompt: text(shot.prompt, "Shot prompt", 12_000),
      firstFramePrompt: text(
        shot.firstFramePrompt,
        "First-frame prompt",
        6_000,
      ),
      lastFramePrompt: text(shot.lastFramePrompt, "Last-frame prompt", 6_000),
      continuityNotes: text(shot.continuityNotes, "Continuity notes", 2_000),
      referenceIds,
      recommendedControls,
      audioIntent: { mode: audioMode, reason: text(rawAudioIntent.reason, "Audio intent reason", 1_000) },
      candidateVariations,
    };
  });
  const rawBundle = root.instructionBundle === undefined
    ? {
        directorVersion: "legacy-runtime-api",
        enhancerVersion: "legacy-runtime-api",
        framePromptVersion: "legacy-runtime-api",
        hash: "0".repeat(64),
      }
    : object(root.instructionBundle, "Instruction bundle");
  exactKeys(rawBundle, new Set(["directorVersion", "enhancerVersion", "framePromptVersion", "hash"]), "Instruction bundle");
  const hash = text(rawBundle.hash, "Instruction bundle hash", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Instruction bundle hash is invalid");
  const provider = text(root.provider, "Enhancer provider", 40);
  if (!enhancementProviders.has(provider)) {
    throw new Error("Enhancer provider is unsupported");
  }
  return {
    polishedMasterPrompt: text(
      root.polishedMasterPrompt,
      "Polished master prompt",
      12_000,
    ),
    continuityBible,
    referenceUsagePlan,
    assumptions,
    shots,
    provider: provider as StoryboardEnhancementResponse["provider"],
    model: text(root.model, "Enhancer model", 120),
    instructionBundle: {
      directorVersion: text(rawBundle.directorVersion, "Director version", 80),
      enhancerVersion: text(rawBundle.enhancerVersion, "Enhancer version", 80),
      framePromptVersion: text(rawBundle.framePromptVersion, "Frame prompt version", 80),
      hash,
    },
  };
}

export interface DeployStudioStoryboardEnhancerConfig {
  baseUrl: string;
  token: string;
  runtimeId?: string;
  path?: string;
  authHeaderName?: string;
  authScheme?: string;
  timeoutMs?: number;
}

export class DeployStudioStoryboardEnhancerClient {
  private readonly origin: string;

  constructor(private readonly config: DeployStudioStoryboardEnhancerConfig) {
    const url = new URL(config.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("Deploy Studio enhancer origin is invalid");
    }
    this.origin = url.origin;
    if (
      config.runtimeId &&
      !/^[a-z0-9][a-z0-9-]{0,127}$/.test(config.runtimeId)
    ) {
      throw new Error("Deploy Studio runtime id is invalid");
    }
  }

  async enhance(
    request: StoryboardEnhancementRequest,
  ): Promise<StoryboardEnhancementResponse> {
    const runtimeApi = Boolean(this.config.runtimeId);
    const path =
      this.config.path ??
      (runtimeApi
        ? `/v1/runtimes/${encodeURIComponent(this.config.runtimeId)}/storyboards/enhance`
        : "/api/storyboards/enhance");
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Deploy Studio enhancer path is invalid");
    }
    const headerName =
      this.config.authHeaderName ??
      (runtimeApi
        ? "X-Intelligensi-API-Key"
        : "authorization");
    const authScheme = this.config.authScheme ?? (runtimeApi ? "none" : "Bearer");
    const authentication =
      authScheme.toLowerCase() === "none"
        ? this.config.token
        : `${authScheme} ${this.config.token}`;
    let response: Response;
    try {
      response = await fetch(new URL(path, `${this.origin}/`), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          [headerName]: authentication,
        },
        body: JSON.stringify(
          runtimeApi ? runtimeApiEnhancementRequest(request) : request,
        ),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 100_000),
      });
    } catch {
      throw new Error("storyboard_enhancer_unavailable");
    }
    if (!response.ok) {
      throw new Error(
        response.status === 503
          ? "storyboard_enhancer_unavailable"
          : "storyboard_enhancement_failed",
      );
    }
    try {
      return validateStoryboardEnhancement(await response.json(), request);
    } catch {
      throw new Error("storyboard_enhancement_failed");
    }
  }
}

export function mockStoryboardEnhancement(
  request: StoryboardEnhancementRequest,
): StoryboardEnhancementResponse {
  const references = request.references ?? [];
  const availableControls = request.availableControls ?? [];
  const candidateCount = request.requestedCandidateCount ?? 3;
  const numbers = request.targetShotNumber
    ? [request.targetShotNumber]
    : Array.from({ length: request.shotCount }, (_, index) => index + 1);
  return {
    polishedMasterPrompt: request.masterPrompt,
    continuityBible: request.continuityBible,
    referenceUsagePlan: references.map((reference) => ({
      referenceId: reference.id,
      shotNumbers: numbers,
      purpose: `Keep ${reference.label} consistent across the selected shots.`,
    })),
    assumptions: [],
    shots: numbers.map((shotNumber) => {
      const source = request.shots[shotNumber - 1];
      return {
        shotNumber,
        title: source?.title || `Shot ${shotNumber}`,
        narrativePurpose: `Advance the story through shot ${shotNumber}.`,
        prompt:
          source?.prompt ||
          `${request.masterPrompt} Shot ${shotNumber} of ${request.shotCount}.`,
        firstFramePrompt: `Opening composition for shot ${shotNumber}, preserving established continuity.`,
        lastFramePrompt: `Closing composition for shot ${shotNumber}, leading naturally into the next shot.`,
        continuityNotes:
          "Preserve the established characters, wardrobe, geography, lighting and screen direction.",
        referenceIds: references.map((reference) => reference.id),
        recommendedControls: availableControls.filter((control) => ["start_frame", "end_frame"].includes(control)),
        audioIntent: { mode: "silent", reason: "The deterministic test enhancer does not infer sound." },
        candidateVariations: Array.from(
          { length: candidateCount },
          (_, index) => `Draft ${index + 1}: preserve the story and continuity while varying one camera, pacing, blocking or lighting choice.`,
        ),
      };
    }),
    provider: "mock",
    model: "deterministic-test-enhancer",
    instructionBundle: {
      directorVersion: "mock-2026-08-04.1",
      enhancerVersion: "mock-2026-08-04.1",
      framePromptVersion: "mock-2026-08-04.1",
      hash: "0".repeat(64),
    },
  };
}
