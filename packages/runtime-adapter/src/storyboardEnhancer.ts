import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { boundedInteger } from "./config.js";
import { defaultGeneratedTextPolicy } from "@video-lab/contracts";
import type {
  EnhancedStoryboardShot,
  StoryboardAudioIntent,
  StoryboardContinuityBible,
  StoryboardEnhancementRequest,
  StoryboardEnhancementRuntimeContext,
  StoryboardEnhancementResponse,
  StoryboardGeneratedTextIntent,
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
  "contractVersion",
  "polishedMasterPrompt",
  "negativePrompt",
  "continuityBible",
  "referenceUsagePlan",
  "assumptions",
  "shots",
  "visualReferenceAnalyses",
  "vision",
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
  "generatedTextIntent",
  "candidateVariations",
]);
const enhancementProviders = new Set(["ollama", "llama_cpp", "mock"]);
const MAX_ENHANCEMENT_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_ENHANCEMENT_RESPONSE_BYTES = 2 * 1024 * 1024;
const DIRECTOR_CONTEXT_TOKENS = 32_768;
const DIRECTOR_SYSTEM_TOKEN_RESERVE = 6_000;
const DIRECTOR_CONTEXT_SAFETY_TOKENS = 1_024;
const DIRECTOR_VISUAL_TOKEN_RESERVE = 1_024;

export function assertStoryboardEnhancementContextBudget(
  request: StoryboardEnhancementRequest,
  runtimeContext?: StoryboardEnhancementRuntimeContext,
): void {
  const internal = runtimeApiEnhancementRequest(request, runtimeContext);
  const textEnvelope = {
    ...internal,
    visualReferences: (runtimeContext?.visualReferences ?? []).map((reference) => ({ ...reference, base64: "" })),
  };
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(textEnvelope), "utf8") / 3) + DIRECTOR_SYSTEM_TOKEN_RESERVE;
  const responseShotCount = request.targetShotNumber ? 1 : request.shotCount;
  const outputTokens = Math.min(16_000, Math.max(3_200, responseShotCount * 850));
  const visualTokens = (runtimeContext?.visualReferences.length ?? 0) * DIRECTOR_VISUAL_TOKEN_RESERVE;
  if (inputTokens + outputTokens + visualTokens + DIRECTOR_CONTEXT_SAFETY_TOKENS > DIRECTOR_CONTEXT_TOKENS) {
    throw new Error("storyboard_context_budget_exceeded");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_ENHANCEMENT_RESPONSE_BYTES) throw new Error("response_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ENHANCEMENT_RESPONSE_BYTES) throw new Error("response_too_large");
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function runtimeApiEnhancementRequest(
  request: StoryboardEnhancementRequest,
  runtimeContext?: StoryboardEnhancementRuntimeContext,
): Record<string, unknown> {
  return {
    contractVersion: request.contractVersion,
    operation: request.operation,
    ...(request.userInstruction === undefined
      ? {}
      : { userInstruction: request.userInstruction }),
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
      generatedTextIntent: shot.generatedTextIntent,
      carryPreviousFrame: shot.carryPreviousFrame,
      firstFrameAvailable: shot.firstFrameAvailable,
      lastFrameAvailable: shot.lastFrameAvailable,
    })),
    ...(request.targetShotNumber === undefined
      ? {}
      : { targetShotNumber: request.targetShotNumber }),
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    references: request.references,
    availableControls: request.availableControls,
    audioPolicy: request.audioPolicy,
    generatedTextPolicy: request.generatedTextPolicy,
    requestedCandidateCount: request.requestedCandidateCount,
    videoModel: request.videoModel ?? "ltx-2.3",
    correlationId: runtimeContext?.correlationId ?? randomUUID(),
    visualReferences: runtimeContext?.visualReferences ?? [],
    textOnlyReferenceIds: runtimeContext?.textOnlyReferenceIds ?? [],
  };
}

function deployStudioEnhancementRequest(
  request: StoryboardEnhancementRequest,
): Record<string, unknown> {
  return {
    projectId: request.projectId,
    masterPrompt: request.masterPrompt,
    overallGoal: request.masterPrompt,
    shotCount: request.shotCount,
    generationMode: request.generationMode,
    continuityBible: request.continuityBible,
    shots: request.shots.map((shot) => ({
      shotNumber: shot.shotNumber,
      title: shot.title || `Scene ${shot.shotNumber}`,
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
      generatedTextIntent: shot.generatedTextIntent,
    })),
    ...(request.targetShotNumber === undefined
      ? {}
      : { targetShotNumber: request.targetShotNumber }),
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    audioPolicy: request.audioPolicy,
    generatedTextPolicy: request.generatedTextPolicy,
    videoModel: request.videoModel ?? "ltx-2.3",
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
  if ([...allowed].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label} is missing required fields`);
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

function generatedTextIntent(
  value: unknown,
  request: StoryboardEnhancementRequest,
): StoryboardGeneratedTextIntent {
  const intent = object(
    value ?? { mode: "none", visibleText: [], reason: "Generated visible text defaults to forbidden." },
    "Shot generated-text intent",
  );
  exactKeys(
    intent,
    new Set(["mode", "visibleText", "reason"]),
    "Shot generated-text intent",
  );
  const mode = String(intent.mode) as StoryboardGeneratedTextIntent["mode"];
  if (!["none", "environmental", "explicit_overlay"].includes(mode)) {
    throw new Error("Shot generated-text intent is invalid");
  }
  const visibleText = stringList(
    intent.visibleText,
    "Visible generated text",
    12,
    200,
  );
  if (
    (request.generatedTextPolicy ?? defaultGeneratedTextPolicy()).mode === "forbidden" &&
    (mode !== "none" || visibleText.length > 0)
  ) {
    throw new Error("Shot generated-text intent violates the project policy");
  }
  if (mode === "none" && visibleText.length > 0) {
    throw new Error("Shot generated-text intent contains undeclared visible text");
  }
  return {
    mode,
    visibleText,
    reason: text(intent.reason, "Generated-text intent reason", 1_000),
  };
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function normalizeDeployStudioProvider(provider: unknown): StoryboardEnhancementResponse["provider"] {
  const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (normalized === "ollama" || normalized === "llama_cpp" || normalized === "mock") return normalized;
  return "llama_cpp";
}

function normalizeDeployStudioEnhancement(
  value: unknown,
  request: StoryboardEnhancementRequest,
  runtimeContext?: StoryboardEnhancementRuntimeContext,
): unknown {
  const envelope = recordOrUndefined(value) ?? {};
  const source = recordOrUndefined(envelope.response) ?? envelope;
  const fallback = mockStoryboardEnhancement(request, runtimeContext);
  const rawBible = recordOrUndefined(source.continuityBible) ?? {};
  const continuityBible = Object.fromEntries(
    continuityKeys.map((key) => [
      key,
      typeof rawBible[key] === "string"
        ? rawBible[key]
        : request.continuityBible[key] ?? "",
    ]),
  );
  const expectedNumbers = request.targetShotNumber
    ? [request.targetShotNumber]
    : Array.from({ length: request.shotCount }, (_, index) => index + 1);
  const candidateCount = request.requestedCandidateCount ?? 3;
  const allowedReferenceIds = new Set((request.references ?? []).map((reference) => reference.id));
  const allowedControls = new Set(request.availableControls ?? []);
  const rawShots = Array.isArray(source.shots) ? source.shots : [];
  const expectedVisuals = runtimeContext?.visualReferences ?? [];
  const textOnlyReferenceIds = runtimeContext?.textOnlyReferenceIds ?? [];
  const rawUsagePlan = Array.isArray(source.referenceUsagePlan) ? source.referenceUsagePlan : [];
  const referenceUsagePlan = rawUsagePlan.flatMap((entry) => {
    const rawUsage = recordOrUndefined(entry);
    if (!rawUsage) return [];
    const referenceId = optionalString(rawUsage.referenceId, "");
    if (!allowedReferenceIds.has(referenceId)) return [];
    const shotNumbers = Array.isArray(rawUsage.shotNumbers)
      ? [...new Set(rawUsage.shotNumbers.filter((number): number is number => Number.isInteger(number) && expectedNumbers.includes(number)))]
      : [];
    if (!shotNumbers.length) return [];
    return [{
      referenceId,
      shotNumbers,
      purpose: optionalString(rawUsage.purpose, "Use this reference to preserve continuity for the selected shots."),
    }];
  });
  const rawAnalyses = Array.isArray(source.visualReferenceAnalyses) ? source.visualReferenceAnalyses : [];
  const visualReferenceAnalyses = rawAnalyses.length === expectedVisuals.length
    ? rawAnalyses
    : fallback.visualReferenceAnalyses;
  const shots = expectedNumbers.map((shotNumber, index) => {
    const rawShot = recordOrUndefined(
      rawShots.find((entry) => recordOrUndefined(entry)?.shotNumber === shotNumber) ?? rawShots[index],
    ) ?? {};
    const requestShot = request.shots.find((shot) => shot.shotNumber === shotNumber);
    const fallbackShot = fallback.shots[index];
    const audioIntent = recordOrUndefined(rawShot.audioIntent);
    const generatedTextIntent = recordOrUndefined(rawShot.generatedTextIntent);
    const rawCandidates = optionalStringArray(rawShot.candidateVariations) ?? [];
    const candidateVariations = Array.from(
      { length: candidateCount },
      (_, candidateIndex) =>
        rawCandidates[candidateIndex] ??
        fallbackShot.candidateVariations[candidateIndex] ??
        `Draft ${candidateIndex + 1}: preserve the Director-enhanced story and continuity while varying one camera, pacing, blocking or lighting choice.`,
    );
    return {
      shotNumber,
      title: optionalString(rawShot.title, requestShot?.title || fallbackShot.title),
      narrativePurpose: optionalString(rawShot.narrativePurpose, fallbackShot.narrativePurpose),
      prompt: optionalString(rawShot.prompt, requestShot?.prompt || fallbackShot.prompt),
      firstFramePrompt: optionalString(rawShot.firstFramePrompt, requestShot?.firstFramePrompt || fallbackShot.firstFramePrompt),
      lastFramePrompt: optionalString(rawShot.lastFramePrompt, requestShot?.lastFramePrompt || fallbackShot.lastFramePrompt),
      continuityNotes: optionalString(rawShot.continuityNotes, requestShot?.continuityNotes || fallbackShot.continuityNotes),
      referenceIds: (optionalStringArray(rawShot.referenceIds) ?? fallbackShot.referenceIds).filter((id) => allowedReferenceIds.has(id)),
      recommendedControls: (optionalStringArray(rawShot.recommendedControls) ?? fallbackShot.recommendedControls).filter((control) => allowedControls.has(control)),
      audioIntent: {
        mode: ["silent", "dialogue", "ambience", "sound_effects", "music", "mixed"].includes(String(audioIntent?.mode))
          ? audioIntent?.mode
          : fallbackShot.audioIntent.mode,
        reason: optionalString(audioIntent?.reason, fallbackShot.audioIntent.reason),
      },
      generatedTextIntent: {
        mode: ["none", "environmental", "explicit_overlay"].includes(String(generatedTextIntent?.mode))
          ? generatedTextIntent?.mode
          : fallbackShot.generatedTextIntent.mode,
        visibleText: optionalStringArray(generatedTextIntent?.visibleText) ?? fallbackShot.generatedTextIntent.visibleText,
        reason: optionalString(generatedTextIntent?.reason, fallbackShot.generatedTextIntent.reason),
      },
      candidateVariations,
    };
  });
  const instructionBundle = recordOrUndefined(source.instructionBundle);
  const bundleHash = optionalString(
    instructionBundle?.hash,
    createHash("sha256").update(JSON.stringify({
      projectId: request.projectId,
      masterPrompt: request.masterPrompt,
      model: source.model,
      provider: source.provider,
    })).digest("hex"),
  ).toLowerCase();
  return {
    contractVersion: "2",
    polishedMasterPrompt: optionalString(source.polishedMasterPrompt, request.masterPrompt),
    negativePrompt: optionalString(source.negativePrompt, fallback.negativePrompt),
    continuityBible,
    referenceUsagePlan: referenceUsagePlan.length ? referenceUsagePlan : fallback.referenceUsagePlan,
    assumptions: optionalStringArray(source.assumptions) ?? fallback.assumptions,
    shots,
    visualReferenceAnalyses,
    vision: {
      mode: "planning_only",
      attachedReferenceIds: expectedVisuals.map((reference) => reference.referenceId),
      textOnlyReferenceIds,
    },
    provider: normalizeDeployStudioProvider(source.provider),
    model: optionalString(source.model, "deploy-studio-director"),
    instructionBundle: {
      directorVersion: optionalString(instructionBundle?.directorVersion, "deploy-studio-director"),
      enhancerVersion: optionalString(instructionBundle?.enhancerVersion, "deploy-studio-enhancer"),
      framePromptVersion: optionalString(instructionBundle?.framePromptVersion, "deploy-studio-frame-prompts"),
      hash: /^[a-f0-9]{64}$/.test(bundleHash) ? bundleHash : createHash("sha256").update(bundleHash).digest("hex"),
    },
  };
}

export function validateStoryboardEnhancement(
  value: unknown,
  request: StoryboardEnhancementRequest,
  runtimeContext?: StoryboardEnhancementRuntimeContext,
): StoryboardEnhancementResponse {
  const root = object(value, "Storyboard enhancement");
  if (root.contractVersion !== "2") {
    throw new Error("Storyboard enhancement contract version is incompatible");
  }
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
  const rawReferenceUsagePlan = root.referenceUsagePlan;
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
  const assumptions = stringList(root.assumptions, "Director assumption", 24, 1_000);
  const expectedVisuals = runtimeContext?.visualReferences ?? [];
  if (!Array.isArray(root.visualReferenceAnalyses) || root.visualReferenceAnalyses.length !== expectedVisuals.length) {
    throw new Error("Visual reference analyses do not match the attached references");
  }
  const visualReferenceAnalyses = root.visualReferenceAnalyses.map((entry, index) => {
    const analysis = object(entry, `Visual reference analysis ${index + 1}`);
    exactKeys(
      analysis,
      new Set([
        "referenceId",
        "referenceVersion",
        "observedTraits",
        "continuityGuidance",
        "declaredVisibleConflicts",
      ]),
      `Visual reference analysis ${index + 1}`,
    );
    const expected = expectedVisuals[index];
    if (
      analysis.referenceId !== expected.referenceId ||
      analysis.referenceVersion !== expected.version
    ) {
      throw new Error("Visual reference analysis order or version is invalid");
    }
    return {
      referenceId: expected.referenceId,
      referenceVersion: expected.version,
      observedTraits: stringList(analysis.observedTraits, "Observed visual trait", 24, 500),
      continuityGuidance: text(analysis.continuityGuidance, "Visual continuity guidance", 2_000),
      declaredVisibleConflicts: stringList(analysis.declaredVisibleConflicts, "Visual reference conflict", 16, 500),
    };
  });
  const rawVision = object(root.vision, "Vision summary");
  exactKeys(rawVision, new Set(["mode", "attachedReferenceIds", "textOnlyReferenceIds"]), "Vision summary");
  if (rawVision.mode !== "planning_only") throw new Error("Vision mode is invalid");
  const attachedReferenceIds = stringList(rawVision.attachedReferenceIds, "Attached reference id", 6, 64);
  const textOnlyReferenceIds = stringList(rawVision.textOnlyReferenceIds, "Text-only reference id", 32, 64);
  if (
    JSON.stringify(attachedReferenceIds) !== JSON.stringify(expectedVisuals.map((reference) => reference.referenceId)) ||
    JSON.stringify(textOnlyReferenceIds) !== JSON.stringify(runtimeContext?.textOnlyReferenceIds ?? [])
  ) {
    throw new Error("Vision reference accounting is invalid");
  }
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
    const referenceIds = stringList(shot.referenceIds, "Shot reference id", 16, 64);
    if (referenceIds.some((id) => !allowedReferenceIds.has(id))) throw new Error("Shot contains an unknown reference id");
    const recommendedControls = stringList(shot.recommendedControls, "Shot control", 16, 64);
    if (recommendedControls.some((control) => !allowedControls.has(control))) throw new Error("Shot contains an unsupported control");
    const rawAudioIntent = object(shot.audioIntent, "Shot audio intent");
    exactKeys(rawAudioIntent, new Set(["mode", "reason"]), "Shot audio intent");
    const audioMode = String(rawAudioIntent.mode) as StoryboardAudioIntent["mode"];
    if (!["silent", "dialogue", "ambience", "sound_effects", "music", "mixed"].includes(audioMode)) throw new Error("Shot audio intent is invalid");
    const candidateVariations = stringList(shot.candidateVariations, "Candidate variation", 4, 2_000);
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
      generatedTextIntent: generatedTextIntent(shot.generatedTextIntent, request),
      candidateVariations,
    };
  });
  const rawBundle = object(root.instructionBundle, "Instruction bundle");
  exactKeys(rawBundle, new Set(["directorVersion", "enhancerVersion", "framePromptVersion", "hash"]), "Instruction bundle");
  const hash = text(rawBundle.hash, "Instruction bundle hash", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Instruction bundle hash is invalid");
  const provider = text(root.provider, "Enhancer provider", 40);
  if (!enhancementProviders.has(provider)) {
    throw new Error("Enhancer provider is unsupported");
  }
  return {
    contractVersion: "2",
    polishedMasterPrompt: text(
      root.polishedMasterPrompt,
      "Polished master prompt",
      12_000,
    ),
    negativePrompt: text(root.negativePrompt, "Negative prompt", 4_000),
    continuityBible,
    referenceUsagePlan,
    assumptions,
    shots,
    visualReferenceAnalyses,
    vision: { mode: "planning_only", attachedReferenceIds, textOnlyReferenceIds },
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
  requestFormat?: "deploy-studio" | "runtime-api";
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
    runtimeContext?: StoryboardEnhancementRuntimeContext,
  ): Promise<StoryboardEnhancementResponse> {
    assertStoryboardEnhancementContextBudget(request, runtimeContext);
    const runtimeApi = this.config.requestFormat
      ? this.config.requestFormat === "runtime-api"
      : Boolean(this.config.runtimeId);
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
    const body = JSON.stringify(
      runtimeApi
        ? runtimeApiEnhancementRequest(request, runtimeContext)
        : deployStudioEnhancementRequest(request),
    );
    if (new TextEncoder().encode(body).byteLength > MAX_ENHANCEMENT_REQUEST_BYTES) {
      throw new Error("storyboard_enhancement_request_too_large");
    }
    try {
      response = await fetch(new URL(path, `${this.origin}/`), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          [headerName]: authentication,
        },
        body,
        signal: AbortSignal.timeout(
          boundedInteger(
            this.config.timeoutMs,
            250_000,
            30_000,
            10 * 60_000,
          ),
        ),
      });
    } catch (cause) {
      throw new Error("storyboard_enhancer_unavailable", { cause });
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        response.status === 413
          ? "storyboard_context_budget_exceeded"
          : response.status === 400
          ? "storyboard_enhancement_request_rejected"
          : response.status === 404 || response.status === 409
          ? "storyboard_enhancement_contract_incompatible"
          : response.status === 503
          ? "storyboard_enhancer_unavailable"
          : "storyboard_enhancement_failed",
        { cause: `HTTP ${response.status} ${response.statusText}: ${bodyText.slice(0, 500)}` },
      );
    }
    try {
      const rawResult = await boundedJson(response);
      const result = validateStoryboardEnhancement(
        runtimeApi
          ? rawResult
          : normalizeDeployStudioEnhancement(rawResult, request, runtimeContext),
        request,
        runtimeContext,
      );
      if (runtimeApi && result.provider === "mock") {
        throw new Error("stable_runtime_provider_invalid");
      }
      return result;
    } catch (cause) {
      throw new Error("storyboard_enhancement_failed", { cause });
    }
  }
}

export function mockStoryboardEnhancement(
  request: StoryboardEnhancementRequest,
  runtimeContext?: StoryboardEnhancementRuntimeContext,
): StoryboardEnhancementResponse {
  const references = request.references ?? [];
  const availableControls = request.availableControls ?? [];
  const candidateCount = request.requestedCandidateCount ?? 3;
  const numbers = request.targetShotNumber
    ? [request.targetShotNumber]
    : Array.from({ length: request.shotCount }, (_, index) => index + 1);
  return {
    contractVersion: "2",
    polishedMasterPrompt: request.masterPrompt,
    negativePrompt: "blur, flicker, malformed anatomy, duplicate subjects, identity drift, inconsistent lighting, compression artefacts, unwanted visible text",
    continuityBible: request.continuityBible,
    referenceUsagePlan: references.map((reference) => ({
      referenceId: reference.id,
      shotNumbers: numbers,
      purpose: `Keep ${reference.label} consistent across the selected shots.`,
    })),
    assumptions: [],
    visualReferenceAnalyses: (runtimeContext?.visualReferences ?? []).map((reference) => ({
      referenceId: reference.referenceId,
      referenceVersion: reference.version,
      observedTraits: [`Visual reference supplied for ${reference.label}.`],
      continuityGuidance: `Preserve the visible identity and composition cues from ${reference.label}.`,
      declaredVisibleConflicts: [],
    })),
    vision: {
      mode: "planning_only",
      attachedReferenceIds: (runtimeContext?.visualReferences ?? []).map((reference) => reference.referenceId),
      textOnlyReferenceIds: runtimeContext?.textOnlyReferenceIds ?? [],
    },
    shots: numbers.map((shotNumber) => {
      const source = request.shots[shotNumber - 1];
      return {
        shotNumber,
        title: source?.title || `Shot ${shotNumber}`,
        narrativePurpose: `Advance the story through shot ${shotNumber}.`,
        prompt:
          request.userInstruction
            ? `Directed revision for scene ${shotNumber}: ${request.userInstruction} ${source?.prompt ?? ""}`.trim()
            : source?.prompt || `${request.masterPrompt} Shot ${shotNumber} of ${request.shotCount}.`,
        firstFramePrompt: `Opening composition for shot ${shotNumber}, preserving established continuity.`,
        lastFramePrompt: `Closing composition for shot ${shotNumber}, leading naturally into the next shot.`,
        continuityNotes:
          "Preserve the established characters, wardrobe, geography, lighting and screen direction.",
        referenceIds: references.map((reference) => reference.id),
        recommendedControls: availableControls.filter((control) => ["start_frame", "end_frame"].includes(control)),
        audioIntent: { mode: "silent", reason: "The deterministic test enhancer does not infer sound." },
        generatedTextIntent: {
          mode: "none",
          visibleText: [],
          reason: "Visible generated text is disabled for the Creator launch workflow.",
        },
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
