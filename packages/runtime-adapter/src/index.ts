declare const process: { env: Record<string, string | undefined> };
import type {
  Generation,
  LongFormVideoModel,
  LongFormVideoModelCapability,
} from "@video-lab/contracts";
import { boundedInteger } from "./config.js";

export * from "./storyboardEnhancer.js";
export * from "./config.js";

const publicRuntimeStages = new Set([
  "queued",
  "validating",
  "planning_opening_frame",
  "generating_start_frame",
  "generating_end_frame",
  "generating_scene",
  "repairing_generated_text",
  "cancelling",
  "assembly",
  "assembling",
  "uploading",
  "completed",
  "cancelled",
]);

function safePublicRuntimeText(value: unknown, maximumLength = 500) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maximumLength || /[\r\n]/.test(text)) return undefined;
  if (
    /https?:\/\/|\b(?:localhost|lambda|ollama|comfyui|docker|container|cuda)\b|\bbearer\s+|\b(?:api[_ -]?key|access[_ -]?token|secret)\b|(?:\d{1,3}\.){3}\d{1,3}|[a-z]:\\|\/(?:home|mnt|opt|root|tmp|var|workspace)\//i.test(
      text,
    )
  )
    return undefined;
  return text;
}

function safeRuntimeStage(value: unknown) {
  const stage = typeof value === "string" ? value.trim().toLowerCase() : "";
  return publicRuntimeStages.has(stage) ? stage : undefined;
}

function safeRuntimeFailureCode(value: unknown) {
  const code = typeof value === "string" ? value.trim() : "";
  return /^runtime_[a-z0-9_]{1,80}$/.test(code) ? code : undefined;
}

function publicRuntimeMessage(
  state: RuntimeGenerationStatus["state"],
  stage: string | undefined,
  failureCode?: string,
) {
  if (state === "failed") {
    const knownMessages: Record<string, string> = {
      runtime_generation_timeout:
        "Generation timed out. The previous successful version remains available.",
      runtime_gpu_memory_exhausted:
        "The generator ran out of working memory. Retry with shorter or lower-resolution settings.",
      runtime_gpu_unavailable:
        "Generation capacity is temporarily unavailable. Please retry shortly.",
      runtime_media_processing_failed:
        "The generated media could not be finalised. The previous successful version remains available.",
      runtime_model_unavailable:
        "A required generation model is temporarily unavailable. Please retry shortly.",
      runtime_video_encoding_failed:
        "The runtime could not encode the generated video. Retry this scene; if it repeats, turn off generated sound and try again.",
      runtime_workflow_rejected:
        "The requested settings are not supported by the active generator.",
      runtime_workflow_unavailable:
        "The requested generation workflow is temporarily unavailable.",
      runtime_generated_text_policy_failed:
        "The runtime could not complete this generation. The previous successful version remains available.",
      runtime_generated_text_validation_missing:
        "The runtime could not complete this generation. The previous successful version remains available.",
    };
    return (
      (failureCode ? knownMessages[failureCode] : undefined) ??
      "The runtime could not complete this generation. The previous successful version remains available."
    );
  }
  if (state === "queued") return "Waiting for generation capacity";
  if (state === "preparing") return "Preparing generation";
  if (state === "uploading") return "Finalising output";
  if (state !== "generating") return undefined;
  if (stage === "cancelling") return "Cancelling generation";
  if (stage === "generating_start_frame") return "Generating opening frame";
  if (stage === "generating_end_frame") return "Generating closing frame";
  if (stage === "planning_opening_frame") return "Planning opening frame";
  if (stage === "assembly" || stage === "assembling") return "Assembling film";
  if (stage === "validating") return "Validating generation";
  if (stage === "generating_scene") return "Rendering scene";
  if (stage === "repairing_generated_text") return "Repairing unwanted text";
  return "Rendering generation";
}

function optionalPositiveInteger<K extends string>(key: K, value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0
    ? ({ [key]: number } as Record<K, number>)
    : {};
}

function generatedVisibleTextForbidden(settings: RuntimeVideoSettings) {
  if (settings.generatedTextQualityControlDisabled === true) return false;
  const policy = settings.generatedTextPolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return true;
  }
  return String(policy.mode ?? "forbidden") === "forbidden";
}

function stripDialogueForSilentVideoPrompt(value: string | undefined) {
  if (typeof value !== "string") return value;
  let text = value
    .replace(
      /\b(?:narrator|voiceover|voice-over|host|presenter|contestant|character|speaker|announcer)\s*\([^)]*\)\s*:\s*["“”][\s\S]*?["“”]/gi,
      "The person reacts naturally without any readable on-screen text.",
    )
    .replace(
      /\b(?:narrator|voiceover|voice-over|host|presenter|contestant|character|speaker|announcer)\s*:\s*["“”][\s\S]*?["“”]/gi,
      "The person reacts naturally without any readable on-screen text.",
    )
    .replace(
      /\b(?:says?|speaks?|delivers?|delivering|utters?|remarks?|asks?|replies?|responds?)\b[^.\n:]*:\s*["“”][\s\S]*?["“”]/gi,
      "reacts naturally with expressive body language and no readable on-screen text",
    )
    .replace(
      /\b(?:says?|speaks?|delivers?|delivering|utters?|remarks?|asks?|replies?|responds?)\b[^.\n]*["“”][\s\S]*?["“”]/gi,
      "reacts naturally with expressive body language and no readable on-screen text",
    )
    .replace(
      /\b(?:says?|speaks?|delivers?|delivering|utters?|remarks?|asks?|replies?|responds?)\b[^.\n:]{0,180}:\s*(?:\n\s*)?[^\n][\s\S]*?(?=\n\s*\n|$)/gi,
      "reacts naturally with expressive body language and no readable on-screen text",
    )
    .replace(/["“”][^"“”\n]{6,240}["“”]/g, "")
    .replace(/\b(?:caption|captions|subtitle|subtitles|closed captions|lower third|title card|text overlay|speech bubble)\b/gi, "no readable on-screen text")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) {
    text = "A cinematic visual scene with natural performances, expressive reactions, and no readable on-screen text.";
  }
  return text;
}

function safeQualityAssessment(value: unknown): Generation["qualityAssessment"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.advisory !== "boolean" || !Array.isArray(source.checks)) return undefined;
  const recommendation = ["review", "recommended", "repair"].includes(String(source.recommendation))
    ? String(source.recommendation) as "review" | "recommended" | "repair"
    : "review";
  const checks = source.checks.slice(0, 32).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const check = entry as Record<string, unknown>;
    const status = String(check.status);
    const id = String(check.id ?? "").trim();
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id) || !["passed", "failed", "warning", "not_evaluated"].includes(status)) return [];
    const detail = safePublicRuntimeText(check.detail);
    return [{
      id,
      status: status as "passed" | "failed" | "warning" | "not_evaluated",
      confidence: Math.min(1, Math.max(0, Number(check.confidence) || 0)),
      ...(detail ? { detail } : {}),
    }];
  });
  const score = Math.min(100, Math.max(0, Math.round(Number(source.score) || 0)));
  const requestedVersion = String(source.version ?? "media-qc-v2").trim();
  const version = /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(requestedVersion)
    ? requestedVersion
    : "media-qc-v2";
  return { version, advisory: source.advisory, score, recommendation, checks };
}

export interface RuntimeVideoSettings {
  aspectRatio: "16:9" | "9:16" | "1:1";
  durationSeconds: number;
  quality: "draft" | "standard" | "high";
  seed?: number;
  runtime?: string;
  videoModel?: LongFormVideoModel;
  video_model?: LongFormVideoModel;
  resolution?: string;
  outputFormat?: string;
  negativePrompt?: string;
  enhancePrompt?: boolean;
  fps?: number;
  frameRate?: number;
  guidance?: number;
  cfgGuidance?: number;
  guidanceScale?: number;
  imageSteps?: number;
  startFrameStrength?: number;
  endFrameStrength?: number;
  postProcess?: string;
  seedMode?: string;
  baseSeed?: number;
  assemblyJobIds?: string[];
  assemblySources?: Array<{
    url: string;
    contentType: "video/mp4" | "video/webm";
    sizeBytes: number;
    sha256: string;
  }>;
  overallGoal?: string;
  originalMasterPrompt?: string;
  audioPolicy?: Record<string, unknown>;
  generatedTextPolicy?: Record<string, unknown>;
  generatedTextQualityControlDisabled?: boolean;
  projectId?: string;
  operationScope?:
    "project" | "scene" | "start_frame" | "end_frame" | "assembly";
  operationSceneId?: string;
  framePrompt?: string;
  operationFrameBase64?: string;
  filmBible?: Record<string, string>;
  globalVisualAnchorBase64?: string;
  seedFrameBase64?: string;
  endFrameBase64?: string;
  referenceImageBase64?: string;
  styleReferenceBase64?: string;
  subjectReferenceBase64?: string;
  referenceConditioning?: Array<{
    id: string;
    type: "character" | "location" | "product" | "style";
    version: number;
    imageBase64: string;
    sceneIds: string[];
  }>;
  storyboard?: Array<{
    id: string;
    title: string;
    prompt: string;
    duration: number;
    trimStart: number;
    trimEnd: number;
    seed: number;
    seedOverride?: boolean;
    summary?: string;
    continuityOverrides?: Record<string, string>;
    transition: string;
    transitionDuration: number;
    carryPreviousFrame: boolean;
    referenceIds?: string[];
    audioIntent?: {
      mode: "silent" | "dialogue" | "ambience" | "sound_effects" | "music" | "mixed";
      reason: string;
      dialogue?: string;
      ambience?: string;
      soundEffects?: string;
      music?: string;
      silence?: string;
    };
    generatedTextIntent?: Record<string, unknown>;
    startFrameBase64?: string;
    endFrameBase64?: string;
    keyframes?: Array<{
      id: string;
      timeSeconds: number;
      strength: number;
      temporalKeyframeBase64?: string;
    }>;
  }>;
}

export interface RuntimeHealth {
  ok: boolean;
  provider: string;
  message?: string;
  worker?: string;
  ready?: boolean;
  capabilities?: {
    maxScenes: number;
    maxSceneDurationSeconds: number;
    workflowModes: Array<"text" | "start" | "start_end" | "multi_keyframe" | "reference">;
    operationScopes: Array<
      "project" | "scene" | "start_frame" | "end_frame" | "assembly"
    >;
    postProcess: Array<"none" | "interpolate" | "upscale" | "both">;
    startFrame: boolean;
    endFrame: boolean;
    intermediateKeyframes?: boolean;
    maxIntermediateKeyframes?: number;
    referenceConditioning?: boolean;
    maxSceneReferenceImages?: number;
    generatedOpeningFrame: boolean;
    previousFrameContinuity: boolean;
    sceneAssembly: boolean;
    audioPreservation: boolean;
    styleReference: boolean;
    subjectReference: boolean;
    audioPolicyModes?: Array<"silent" | "intent_only" | "directed">;
    enhancementContractVersion?: "2" | null;
    featureStatus?: Record<string, "supported" | "partial" | "unavailable" | "client_managed">;
    instructionBundle?: { directorVersion: string; enhancerVersion: string; framePromptVersion: string; hash: string };
    defaultVideoModel?: LongFormVideoModel;
    videoModels?: LongFormVideoModelCapability[];
  };
}

export interface RuntimeGenerationInput {
  prompt: string;
  settings: RuntimeVideoSettings;
  inputAssetUrls?: string[];
  idempotencyKey?: string;
}

export interface RuntimeSubmission {
  runtimeJobId: string;
}

export class RuntimeCapacityPendingError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 20) {
    super("runtime_capacity_pending");
    this.name = "RuntimeCapacityPendingError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class RuntimeLeaseUnavailableError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 20) {
    super("runtime_lease_unavailable");
    this.name = "RuntimeLeaseUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function runtimeLeaseUnavailableResponse(
  response: Response,
): Promise<RuntimeLeaseUnavailableError | undefined> {
  if (![404, 409, 503].includes(response.status)) return undefined;
  let code = "";
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    code = typeof body.code === "string" ? body.code : "";
  } catch {
    // A 503 is still an unavailable lease even when the upstream body is empty.
  }
  if (
    response.status === 503 ||
    [
      "job_not_found",
      "runtime_job_lost",
      "runtime_job_not_found",
      "runtime_unavailable",
      "runtime_warming",
      "runtime_capacity_pending",
      "runtime_lease_expired",
    ].includes(code)
  ) {
    return new RuntimeLeaseUnavailableError(
      Number(response.headers.get("retry-after")) || 20,
    );
  }
  return undefined;
}

export interface RuntimeGenerationStatus {
  state:
    | "queued"
    | "preparing"
    | "generating"
    | "uploading"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number;
  message?: string | undefined;
  failureCode?: string | undefined;
  framesRendered?: number;
  totalFrames?: number;
  currentScene?: number;
  totalScenes?: number;
  stage?: string;
  qualityAssessment?: Generation["qualityAssessment"];
}

export interface RuntimeCancelResult {
  cancelled: boolean;
  accepted?: boolean;
}

export interface RuntimeOutput {
  bytes: Uint8Array;
  contentType:
    "video/mp4" | "video/webm" | "image/png" | "image/jpeg" | "image/webp";
  durationSeconds: number;
}

function asciiAt(bytes: Uint8Array, start: number, length: number) {
  if (bytes.length < start + length) return "";
  return Array.from(bytes.slice(start, start + length))
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

function hasImageSignature(bytes: Uint8Array, contentType: RuntimeOutput["contentType"]) {
  if (contentType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/webp") {
    return asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP";
  }
  return false;
}

function hasVideoSignature(bytes: Uint8Array, contentType: RuntimeOutput["contentType"]) {
  if (contentType === "video/mp4") {
    return bytes.length >= 12 && asciiAt(bytes, 4, 4) === "ftyp";
  }
  if (contentType === "video/webm") {
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  return false;
}

function assertRuntimeOutputBytes(bytes: Uint8Array, contentType: RuntimeOutput["contentType"]) {
  if (bytes.length === 0) {
    throw new Error("Sulphur output endpoint returned an empty artifact");
  }
  if (contentType.startsWith("image/") && !hasImageSignature(bytes, contentType)) {
    throw new Error(`Sulphur output endpoint returned invalid ${contentType} bytes`);
  }
  if (contentType.startsWith("video/") && !hasVideoSignature(bytes, contentType)) {
    throw new Error(`Sulphur output endpoint returned invalid ${contentType} bytes`);
  }
}

export interface RuntimePromptCompletion {
  completedPrompt: string;
  mode: "expand";
  provider: string;
}

export interface RuntimeGatewayRuntime {
  runtimeId: string;
  status?: string;
  ready?: boolean;
}

export interface VideoRuntimeAdapter {
  healthCheck(): Promise<RuntimeHealth>;
  completePrompt(
    prompt: string,
    mode?: "expand",
  ): Promise<RuntimePromptCompletion>;
  submitGeneration(input: RuntimeGenerationInput): Promise<RuntimeSubmission>;
  getGenerationStatus(runtimeJobId: string): Promise<RuntimeGenerationStatus>;
  cancelGeneration(runtimeJobId: string): Promise<RuntimeCancelResult>;
  fetchOutput(runtimeJobId: string): Promise<RuntimeOutput>;
  reportCapacityDemand?(
    queueDepth: number,
    oldestQueuedJobAgeSeconds: number,
  ): Promise<void>;
}

export class MockVideoRuntimeAdapter implements VideoRuntimeAdapter {
  private jobs = new Map<
    string,
    { created: number; fail?: boolean; cancelled?: boolean; frame?: boolean }
  >();

  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "mock" };
  }

  async completePrompt(prompt: string): Promise<RuntimePromptCompletion> {
    return {
      completedPrompt: prompt,
      mode: "expand",
      provider: "mock",
    };
  }

  async submitGeneration(
    input: RuntimeGenerationInput,
  ): Promise<RuntimeSubmission> {
    if (input.prompt.includes("[[FAIL_RUNTIME]]")) {
      throw new Error("provider rejection");
    }

    const id = `mock_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.jobs.set(id, {
      created: Date.now(),
      fail: input.prompt.includes("[[TIMEOUT]]"),
      frame:
        input.settings.operationScope === "start_frame" ||
        input.settings.operationScope === "end_frame",
    });
    return { runtimeJobId: id };
  }

  async getGenerationStatus(id: string): Promise<RuntimeGenerationStatus> {
    const job = this.jobs.get(id);
    if (!job)
      return { state: "failed", progress: 0, message: "missing mock job" };
    if (job.cancelled) return { state: "cancelled", progress: 0 };

    const age = Date.now() - job.created;
    if (job.fail && age > 100) throw new Error("runtime timeout");
    if (age < 50) return { state: "preparing", progress: 15 };
    if (age < 100) return { state: "generating", progress: 55 };
    if (age < 150) return { state: "uploading", progress: 90 };
    return {
      state: "completed",
      progress: 100,
      qualityAssessment: {
        version: "generated-text-qc-v1",
        advisory: true,
        score: 100,
        recommendation: "recommended",
        checks: [{
          id: "generated_text_policy",
          status: "passed",
          confidence: 1,
          detail: "Mock output contains no generated visible text.",
        }],
      },
    };
  }

  async cancelGeneration(id: string): Promise<RuntimeCancelResult> {
    const job = this.jobs.get(id);
    if (job) job.cancelled = true;
    return { cancelled: true };
  }

  async fetchOutput(id: string): Promise<RuntimeOutput> {
    const frame = this.jobs.get(id)?.frame === true;
    return {
      bytes: frame
        ? Uint8Array.from([
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
            0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73,
            68, 65, 84, 8, 215, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255,
            137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
          ])
        : new TextEncoder().encode("mock mp4 placeholder"),
      contentType: frame ? "image/png" : "video/mp4",
      durationSeconds: 4,
    };
  }
}

type RuntimePayloadMode = "sulphur" | "deploy-studio" | "intelligensi-api";

export interface SulphurLtxRuntimeConfig {
  baseUrl?: string | undefined;
  token?: string | undefined;
  runtimeId?: string | undefined;
  healthPath?: string | undefined;
  submitPath?: string | undefined;
  statusPath?: string | undefined;
  cancelPath?: string | undefined;
  outputPath?: string | undefined;
  authHeaderName?: string | undefined;
  authScheme?: string | undefined;
  payloadMode?: RuntimePayloadMode | undefined;
  timeoutMs?: number | undefined;
}

export class SulphurLtxRuntimeAdapter implements VideoRuntimeAdapter {
  private detectedWorker?: string;

  constructor(private cfg: SulphurLtxRuntimeConfig) {}

  private requireConfig() {
    if (!this.cfg.baseUrl)
      throw new Error("Sulphur runtime base URL is not configured");
  }

  private url(path: string) {
    this.requireConfig();
    const base = this.cfg.baseUrl!.replace(/\/+$/, "");
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${base}${normalized}`;
  }

  private path(template: string, runtimeJobId: string) {
    return template
      .replaceAll("{runtimeId}", encodeURIComponent(this.runtimeId()))
      .replaceAll("{jobId}", encodeURIComponent(runtimeJobId));
  }

  private runtimeId() {
    const runtimeId =
      this.cfg.runtimeId?.trim() || "longform-ltx-storyboard-studio";
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(runtimeId)) {
      throw new Error("Intelligensi runtime id is invalid");
    }
    return runtimeId;
  }

  private gatewayPath(suffix: string) {
    return `/v1/runtimes/${encodeURIComponent(this.runtimeId())}${suffix}`;
  }

  private defaultVideoModelFromMetadata(value: unknown): LongFormVideoModel | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const defaultEnv = source.defaultEnv && typeof source.defaultEnv === "object" && !Array.isArray(source.defaultEnv)
      ? source.defaultEnv as Record<string, unknown>
      : undefined;
    const envModel = String(defaultEnv?.LONGFORM_VIDEO_MODEL ?? "").trim().toLowerCase();
    if (envModel === "ltx-2.5") return "ltx-2.5";
    if (envModel === "ltx-2.3") return "ltx-2.3";
    const label = [
      source.title,
      source.name,
      source.runtimeTitle,
      source.runtimeName,
      source.image,
      source.imageVariant,
      source.buildVariant,
      source.variant,
      source.runtimeId,
      source.id,
    ]
      .map((entry) => String(entry ?? "").toLowerCase())
      .join(" ");
    if (/\bltx[\s_-]*2\.5\b/.test(label) || /\bltx25\b/.test(label)) return "ltx-2.5";
    if (/\bltx[\s_-]*2\.3\b/.test(label) || /\bltx23\b/.test(label)) return "ltx-2.3";
    return undefined;
  }

  private selectedVideoModel(settings: RuntimeVideoSettings): LongFormVideoModel {
    const value = settings.videoModel ?? settings.video_model;
    return value === "ltx-2.5" ? "ltx-2.5" : "ltx-2.3";
  }

  private defaultPath(kind: "submit" | "status" | "cancel" | "output") {
    if (this.cfg.payloadMode === "intelligensi-api") {
      return {
        submit: this.gatewayPath("/preview"),
        status: this.gatewayPath("/jobs/{jobId}"),
        cancel: this.gatewayPath("/jobs/{jobId}/cancel"),
        output: this.gatewayPath("/jobs/{jobId}/output"),
      }[kind];
    }
    if (this.cfg.payloadMode === "deploy-studio") {
      return {
        submit: "/jobs",
        status: "/jobs/{jobId}",
        cancel: "/jobs/{jobId}/cancel",
        output: "/jobs/{jobId}/output",
      }[kind];
    }

    return {
      submit: "/generations",
      status: "/generations/{jobId}",
      cancel: "/generations/{jobId}/cancel",
      output: "/generations/{jobId}/output",
    }[kind];
  }

  private headers() {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (!this.cfg.token) return headers;

    const headerName =
      this.cfg.authHeaderName ??
      (this.cfg.payloadMode === "intelligensi-api"
        ? "X-Intelligensi-API-Key"
        : "authorization");
    const authScheme =
      this.cfg.authScheme ??
      (this.cfg.payloadMode === "intelligensi-api" ? "none" : "Bearer");
    headers[headerName] =
      authScheme.toLowerCase() === "none"
        ? this.cfg.token
        : `${authScheme} ${this.cfg.token}`;
    return headers;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutOverrideMs?: number,
  ) {
    const timeoutMs = boundedInteger(
      timeoutOverrideMs ?? this.cfg.timeoutMs,
      120_000,
      1_000,
      15 * 60_000,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(this.url(path), {
        ...init,
        headers: { ...this.headers(), ...init.headers },
        signal: controller.signal,
        redirect: "error",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async verifyProtectedAccess(): Promise<{
    ok: boolean;
    status: number;
    message?: string;
  }> {
    const path = this.path(
      this.cfg.statusPath ?? this.defaultPath("status"),
      "video-lab-auth-check",
    );
    const res = await this.request(
      path,
      {},
      Math.min(this.cfg.timeoutMs ?? 120_000, 8_000),
    );
    if (res.status === 401 || res.status === 403 || res.status === 503) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.clone().json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the HTTP status detail.
      }
      return { ok: false, status: res.status, message };
    }
    return { ok: true, status: res.status };
  }

  private payload(input: RuntimeGenerationInput) {
    if (
      this.cfg.payloadMode === "deploy-studio" ||
      this.cfg.payloadMode === "intelligensi-api"
    ) {
      const settings = input.settings;
      const resolution = {
        "16:9": "1280x720",
        "9:16": "720x1280",
        "1:1": "1024x1024",
      }[settings.aspectRatio];
      const isLongForm =
        settings.runtime === "longform-ltx-storyboard-studio" ||
        Boolean(settings.storyboard?.length) ||
        this.detectedWorker === "longform-ltx-storyboard-studio";

      if (isLongForm) {
        const sanitizePrompt = generatedVisibleTextForbidden(settings)
          ? stripDialogueForSilentVideoPrompt
          : (value: string | undefined) => value;
        const storyboard = settings.storyboard?.length
          ? settings.storyboard
          : [
              {
                id: "scene-1",
                title: "Scene 1",
                prompt: input.prompt,
                duration: settings.durationSeconds,
                trimStart: 0,
                trimEnd: settings.durationSeconds,
                seed: settings.seed ?? 1337,
                transition: "cut",
                transitionDuration: 0.75,
                carryPreviousFrame: false,
                ...(settings.seedFrameBase64
                  ? { startFrameBase64: settings.seedFrameBase64 }
                  : {}),
                ...(settings.endFrameBase64
                  ? { endFrameBase64: settings.endFrameBase64 }
                  : {}),
              },
            ];

        const videoModel = this.selectedVideoModel(settings);
        return {
          project_id: settings.projectId,
          videoModel,
          video_model: videoModel,
          operation_scope: settings.operationScope ?? "project",
          operation_scene_id: settings.operationSceneId,
          frame_prompt: sanitizePrompt(settings.framePrompt),
          operation_frame_base64: settings.operationFrameBase64,
          film_bible: settings.filmBible,
          overall_goal: sanitizePrompt(settings.overallGoal ?? input.prompt),
          original_master_prompt: sanitizePrompt(settings.originalMasterPrompt ?? settings.overallGoal ?? input.prompt),
          audio_policy: settings.audioPolicy,
          generated_text_quality_control: settings.generatedTextQualityControlDisabled === true
            ? { enabled: false, mode: "disabled_by_admin" }
            : undefined,
          quality_control: settings.generatedTextQualityControlDisabled === true
            ? { generated_text: false }
            : undefined,
          prompt: sanitizePrompt(input.prompt),
          negative_prompt: settings.negativePrompt,
          resolution: settings.resolution ?? resolution,
          fps: settings.fps ?? settings.frameRate ?? 24,
          image_steps: settings.imageSteps,
          guidance_scale:
            settings.guidanceScale ?? settings.cfgGuidance ?? settings.guidance,
          start_frame_strength: settings.startFrameStrength,
          end_frame_strength: settings.endFrameStrength,
          enhance_prompt: settings.enhancePrompt,
          post_process: settings.postProcess ?? "none",
          output_format: settings.outputFormat ?? "mp4",
          seed_mode: settings.seedMode ?? "per_scene",
          base_seed: settings.baseSeed ?? settings.seed,
          assembly_job_ids: settings.assemblyJobIds,
          assembly_sources: settings.assemblySources?.map((source) => ({
            url: source.url,
            content_type: source.contentType,
            size_bytes: source.sizeBytes,
            sha256: source.sha256,
          })),
          global_visual_anchor_base64: settings.globalVisualAnchorBase64,
          reference_conditioning: settings.referenceConditioning?.map((reference) => ({
            id: reference.id,
            type: reference.type,
            version: reference.version,
            image_base64: reference.imageBase64,
            scene_ids: reference.sceneIds,
          })),
          storyboard: storyboard.map((scene) => ({
            id: scene.id,
            title: scene.title,
            prompt: sanitizePrompt(scene.prompt),
            duration: scene.duration,
            trim_start: scene.trimStart,
            trim_end: scene.trimEnd,
            seed: scene.seed,
            seed_override: scene.seedOverride === true,
            summary: scene.summary,
            continuity_overrides: scene.continuityOverrides,
            transition: scene.transition,
            transition_duration: scene.transitionDuration,
            carry_previous_frame: scene.carryPreviousFrame,
            reference_ids: scene.referenceIds,
            audio_intent: scene.audioIntent
              ? {
                  mode: scene.audioIntent.mode,
                  reason: scene.audioIntent.reason,
                  dialogue: scene.audioIntent.dialogue,
                  ambience: scene.audioIntent.ambience,
                  sound_effects: scene.audioIntent.soundEffects,
                  music: scene.audioIntent.music,
                  silence: scene.audioIntent.silence,
                }
              : undefined,
            start_frame_base64: scene.startFrameBase64,
            end_frame_base64: scene.endFrameBase64,
            keyframes: scene.keyframes?.map((keyframe) => ({
              id: keyframe.id,
              time_seconds: keyframe.timeSeconds,
              strength: keyframe.strength,
              image_base64: keyframe.temporalKeyframeBase64,
            })),
          })),
        };
      }

      return {
        prompt: input.prompt,
        negative_prompt: settings.negativePrompt,
        resolution: settings.resolution ?? resolution,
        duration: settings.durationSeconds,
        fps: settings.frameRate ?? settings.fps ?? 24,
        output_format: settings.outputFormat ?? "mp4",
        seed: settings.seed,
        cfg: settings.cfgGuidance ?? settings.guidance,
        guidance_scale: settings.guidance ?? settings.cfgGuidance,
        enhance_prompt: settings.enhancePrompt,
        seed_frame_base64: settings.seedFrameBase64,
        end_frame_base64: settings.endFrameBase64,
        reference_image_base64: settings.referenceImageBase64,
        style_reference_base64: settings.styleReferenceBase64,
        subject_reference_base64: settings.subjectReferenceBase64,
      };
    }

    return {
      prompt: input.prompt,
      options: input.settings,
      inputAssetUrls: input.inputAssetUrls ?? [],
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    const res = await this.request(
      this.cfg.healthPath ??
        (this.cfg.payloadMode === "intelligensi-api"
          ? this.gatewayPath("/health")
          : "/health"),
      {},
      Math.min(this.cfg.timeoutMs ?? 120_000, 8_000),
    );
    let body: {
      ok?: boolean;
      ready?: boolean;
      worker?: string;
      error?: string | null;
      defaultEnv?: Record<string, unknown>;
      title?: unknown;
      name?: unknown;
      image?: unknown;
      imageVariant?: unknown;
      buildVariant?: unknown;
      variant?: unknown;
      capabilities?: {
        workflow_modes?: unknown;
        default_video_model?: unknown;
        video_models?: unknown;
        style_reference?: unknown;
        subject_reference?: unknown;
        reference_conditioning?: unknown;
        project_reference_planning?: unknown;
      };
      advanced_video_controls?: {
        start_frame_supported?: unknown;
        end_frame_supported?: unknown;
        intermediate_keyframes_supported?: unknown;
        max_intermediate_keyframes?: unknown;
        reference_conditioning_supported?: unknown;
        max_scene_reference_images?: unknown;
      };
      storyboard?: {
        max_scenes?: unknown;
        continuity?: unknown;
        post_process?: unknown;
      };
      runtimeId?: string;
      id?: string;
      runtimeTitle?: unknown;
      runtimeName?: unknown;
      status?: string;
      features?: RuntimeHealth["capabilities"];
    } = {};
    try {
      body = (await res.clone().json()) as typeof body;
    } catch {
      // Some compatible runtimes expose an empty health response.
    }
    this.detectedWorker =
      body.worker ??
      (this.cfg.payloadMode === "intelligensi-api"
        ? body.runtimeId ?? this.runtimeId()
        : undefined);
    const ready = body.ready ?? body.ok ?? res.ok;
    if (this.cfg.payloadMode === "intelligensi-api") {
      const features = (body.features ?? {}) as Partial<RuntimeHealth["capabilities"]>;
      const inferredDefault =
        this.defaultVideoModelFromMetadata(body) ??
        (features.defaultVideoModel === "ltx-2.5" ? "ltx-2.5" : features.defaultVideoModel === "ltx-2.3" ? "ltx-2.3" : undefined);
      const videoModels: LongFormVideoModelCapability[] | undefined = features.videoModels?.length
        ? features.videoModels
        : inferredDefault === "ltx-2.5"
          ? [
              { id: "ltx-2.3" as const, label: "LTX 2.3", status: "unavailable" as const, available: false, recommended: false, workflowModes: [] },
              { id: "ltx-2.5" as const, label: "LTX 2.5", status: "preview" as const, available: true, recommended: true, workflowModes: features.workflowModes ?? ["text", "start", "start_end"] },
            ]
          : features.videoModels;
      return {
        ok: res.ok && ready === true && body.status === "ready",
        provider: body.runtimeId ?? this.runtimeId(),
        worker: body.runtimeId ?? this.runtimeId(),
        ready,
        capabilities: {
          maxScenes: features.maxScenes ?? 24,
          maxSceneDurationSeconds: features.maxSceneDurationSeconds ?? 8,
          workflowModes: features.workflowModes ?? ["text", "start", "start_end"],
          operationScopes: features.operationScopes ?? ["project", "scene", "start_frame", "end_frame", "assembly"],
          postProcess: features.postProcess ?? ["none"],
          startFrame: features.startFrame ?? true,
          endFrame: features.endFrame ?? true,
          generatedOpeningFrame: features.generatedOpeningFrame ?? true,
          previousFrameContinuity: features.previousFrameContinuity ?? true,
          sceneAssembly: features.sceneAssembly ?? true,
          audioPreservation: features.audioPreservation ?? true,
          styleReference: features.styleReference ?? false,
          subjectReference: features.subjectReference ?? false,
          ...features,
          ...(inferredDefault ? { defaultVideoModel: inferredDefault } : {}),
          ...(videoModels ? { videoModels } : {}),
        },
        message:
          res.ok && ready === true
            ? "healthy"
            : `${res.status} ${res.statusText}`,
      };
    }
    const workflowModes: Array<"text" | "start" | "start_end" | "multi_keyframe" | "reference"> = Array.isArray(
      body.capabilities?.workflow_modes,
    )
      ? body.capabilities.workflow_modes.filter(
          (value): value is "text" | "start" | "start_end" | "multi_keyframe" | "reference" =>
            ["text", "start", "start_end", "multi_keyframe", "reference"].includes(String(value)),
        )
      : ["text", "start", "start_end"];
    const postProcess: Array<"none" | "interpolate" | "upscale" | "both"> =
      Array.isArray(body.storyboard?.post_process)
        ? body.storyboard.post_process.filter(
            (value): value is "none" | "interpolate" | "upscale" | "both" =>
              ["none", "interpolate", "upscale", "both"].includes(
                String(value),
              ),
          )
        : ["none", "interpolate", "upscale", "both"];
    const videoModels: LongFormVideoModelCapability[] = Array.isArray(
      body.capabilities?.video_models,
    )
      ? body.capabilities.video_models.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const model = entry as Record<string, unknown>;
          const id = String(model.id);
          const status = String(model.status);
          if (!(["ltx-2.3", "ltx-2.5"] as string[]).includes(id)) return [];
          if (!(["proven", "preview", "unavailable"] as string[]).includes(status)) return [];
          const modelModes = Array.isArray(model.workflow_modes)
            ? model.workflow_modes.filter(
                (value): value is "text" | "start" | "start_end" | "multi_keyframe" | "reference" =>
                  ["text", "start", "start_end", "multi_keyframe", "reference"].includes(String(value)),
              )
            : [];
          return [{
            id: id as LongFormVideoModel,
            label: safePublicRuntimeText(model.label, 80) ?? id.toUpperCase(),
            status: status as LongFormVideoModelCapability["status"],
            available: model.available === true,
            recommended: model.recommended === true,
            workflowModes: modelModes,
            ...(safePublicRuntimeText(model.reason, 180)
              ? { reason: safePublicRuntimeText(model.reason, 180) }
              : {}),
          }];
        })
      : [{
          id: "ltx-2.3",
          label: "LTX 2.3",
          status: "proven",
          available: true,
          recommended: true,
          workflowModes,
        }];
    const requestedDefaultVideoModel = String(
      body.capabilities?.default_video_model ??
      this.defaultVideoModelFromMetadata(body) ??
      "ltx-2.3",
    );
    const defaultVideoModel: LongFormVideoModel =
      requestedDefaultVideoModel === "ltx-2.5" &&
      videoModels.some((model) => model.id === "ltx-2.5" && model.available)
        ? "ltx-2.5"
        : "ltx-2.3";
    return {
      ok: res.ok && ready,
      provider: body.worker ?? "sulphur-ltx",
      worker: body.worker,
      ready,
      capabilities: {
        maxScenes: Math.min(
          24,
          Math.max(1, Number(body.storyboard?.max_scenes) || 24),
        ),
        maxSceneDurationSeconds: 8,
        workflowModes,
        operationScopes: [
          "project",
          "scene",
          "start_frame",
          "end_frame",
          "assembly",
        ],
        postProcess,
        startFrame:
          body.advanced_video_controls?.start_frame_supported !== false,
        endFrame: body.advanced_video_controls?.end_frame_supported !== false,
        intermediateKeyframes:
          body.advanced_video_controls?.intermediate_keyframes_supported === true &&
          workflowModes.includes("multi_keyframe"),
        maxIntermediateKeyframes: Math.min(
          6,
          Math.max(0, Number(body.advanced_video_controls?.max_intermediate_keyframes) || 0),
        ),
        referenceConditioning:
          body.capabilities?.reference_conditioning === "supported" &&
          body.advanced_video_controls?.reference_conditioning_supported === true,
        maxSceneReferenceImages: Math.min(
          6,
          Math.max(0, Number(body.advanced_video_controls?.max_scene_reference_images) || 0),
        ),
        generatedOpeningFrame: true,
        previousFrameContinuity:
          body.storyboard?.continuity === "actual_previous_clip_last_frame",
        sceneAssembly: true,
        audioPreservation: true,
        styleReference:
          body.capabilities?.style_reference !==
          "not_supported_by_this_runtime",
        subjectReference:
          body.capabilities?.subject_reference !==
          "not_supported_by_this_runtime",
        audioPolicyModes: ["silent", "intent_only", "directed"],
        defaultVideoModel,
        videoModels,
        featureStatus: {
          startEndFrames: "supported",
          multipleKeyframes:
            body.advanced_video_controls?.intermediate_keyframes_supported === true &&
            workflowModes.includes("multi_keyframe")
              ? "supported"
              : "unavailable",
          referencePlanning:
            body.capabilities?.project_reference_planning === "director_and_runtime"
              ? "supported"
              : body.capabilities?.project_reference_planning === "director_only"
                ? "partial"
                : "unavailable",
          referenceConditioning:
            body.capabilities?.reference_conditioning === "supported" &&
            body.advanced_video_controls?.reference_conditioning_supported === true
              ? "supported"
              : "unavailable",
          candidateVersions: "client_managed",
          qualityAssessment: "partial",
          retake: "unavailable",
          extend: "unavailable",
          reframe: "unavailable",
          videoToVideo: "unavailable",
          hdr: "unavailable",
        },
      },
      message:
        res.ok && ready
          ? "healthy"
          : (body.error ?? `${res.status} ${res.statusText}`),
    };
  }

  async completePrompt(
    prompt: string,
    mode: "expand" = "expand",
  ): Promise<RuntimePromptCompletion> {
    const res = await this.request(
      this.cfg.payloadMode === "intelligensi-api"
        ? this.gatewayPath("/prompt/complete")
        : "/prompt/complete",
      {
        method: "POST",
        body: JSON.stringify({ prompt, mode }),
      },
      Math.max(this.cfg.timeoutMs ?? 120_000, 180_000),
    );
    if (!res.ok)
      throw new Error(`Sulphur prompt completion failed: ${await res.text()}`);
    const result = (await res.json()) as Partial<RuntimePromptCompletion> & {
      completion?: string;
      runtimeId?: string;
    };
    const completedPrompt = (
      result.completedPrompt ?? result.completion
    )?.trim();
    if (!completedPrompt)
      throw new Error("Sulphur prompt completion returned empty text");
    return {
      completedPrompt,
      mode: "expand",
      provider:
        result.provider ??
        result.runtimeId ??
        (this.cfg.payloadMode === "intelligensi-api"
          ? this.runtimeId()
          : "sulphur-gemma"),
    };
  }

  async discoverReadyRuntime(
    capability = "storyboard-enhance",
  ): Promise<RuntimeGatewayRuntime | undefined> {
    if (this.cfg.payloadMode !== "intelligensi-api") return undefined;
    const path = `/v1/runtimes?capability=${encodeURIComponent(capability)}&ready=true`;
    const res = await this.request(path, {}, Math.min(this.cfg.timeoutMs ?? 120_000, 8_000));
    if (!res.ok)
      throw new Error(`Deploy Studio runtime discovery failed: ${await res.text()}`);
    const json = (await res.json()) as {
      runtimes?: Array<{ runtimeId?: string; id?: string; status?: string; ready?: boolean }>;
      items?: Array<{ runtimeId?: string; id?: string; status?: string; ready?: boolean }>;
    } | Array<{ runtimeId?: string; id?: string; status?: string; ready?: boolean }>;
    const runtimes = Array.isArray(json) ? json : (json.runtimes ?? json.items ?? []);
    const expectedRuntimeId = this.runtimeId();
    const match = runtimes.find((runtime) => (runtime.runtimeId ?? runtime.id) === expectedRuntimeId);
    if (!match) return undefined;
    return {
      runtimeId: match.runtimeId ?? match.id ?? expectedRuntimeId,
      status: match.status,
      ready: match.ready,
    };
  }

  async reportCapacityDemand(
    queueDepth: number,
    oldestQueuedJobAgeSeconds: number,
  ): Promise<void> {
    if (this.cfg.payloadMode !== "intelligensi-api") return;
    const res = await this.request(
      this.gatewayPath("/capacity-demand"),
      {
        method: "POST",
        body: JSON.stringify({ queueDepth, oldestQueuedJobAgeSeconds }),
      },
      Math.min(this.cfg.timeoutMs ?? 120_000, 8_000),
    );
    if (!res.ok)
      throw new Error(`Deploy Studio capacity report failed: ${await res.text()}`);
  }

  async submitGeneration(
    input: RuntimeGenerationInput,
  ): Promise<RuntimeSubmission> {
    const requestPath = this.cfg.submitPath ?? this.defaultPath("submit");
    const requestInit: RequestInit = {
      method: "POST",
      headers: input.idempotencyKey
        ? { "Idempotency-Key": input.idempotencyKey }
        : undefined,
      body: JSON.stringify(this.payload(input)),
    };
    let res: Response;
    try {
      res = await this.request(requestPath, requestInit);
    } catch (error) {
      if (input.idempotencyKey) {
        try {
          // A paid worker may have accepted the first request before its HTTP
          // response was lost. Replay the exact request once with the same
          // durable key so Deploy Studio resolves the original assignment.
          res = await this.request(requestPath, requestInit);
        } catch {
          if (input.settings.operationScope === "assembly") {
            throw new RuntimeLeaseUnavailableError();
          }
          throw error;
        }
      } else {
        if (input.settings.operationScope === "assembly") {
          throw new RuntimeLeaseUnavailableError();
        }
        throw error;
      }
    }

    if (!res.ok) {
      let responseCode = "";
      try {
        const body = (await res.clone().json()) as { code?: unknown };
        responseCode = typeof body.code === "string" ? body.code : "";
      } catch {
        // Fall through to the normal status-based classification.
      }
      if (
        responseCode === "runtime_submission_uncertain" ||
        responseCode === "idempotency_in_progress"
      ) {
        throw new RuntimeCapacityPendingError(
          Number(res.headers.get("retry-after")) || 5,
        );
      }
      const leaseError = await runtimeLeaseUnavailableResponse(res);
      if (leaseError) throw new RuntimeCapacityPendingError(leaseError.retryAfterSeconds);
      const responseText = await res.text();
      if (res.status === 429 && /runtime_capacity_pending|rate_limited/i.test(responseText)) {
        throw new RuntimeCapacityPendingError(Number(res.headers.get("retry-after")) || 20);
      }
      throw new Error(`Sulphur submission failed: ${responseText}`);
    }
    const json = (await res.json()) as {
      id?: string;
      jobId?: string;
      job_id?: string;
    };
    const runtimeJobId = json.jobId ?? json.job_id ?? json.id;
    if (!runtimeJobId)
      throw new Error("Sulphur submission did not return a job id");
    return { runtimeJobId };
  }

  async getGenerationStatus(
    runtimeJobId: string,
  ): Promise<RuntimeGenerationStatus> {
    const path = this.path(
      this.cfg.statusPath ?? this.defaultPath("status"),
      runtimeJobId,
    );
    let res: Response;
    try {
      res = await this.request(path);
    } catch {
      throw new RuntimeLeaseUnavailableError();
    }
    if (!res.ok) {
      const leaseError = await runtimeLeaseUnavailableResponse(res);
      if (leaseError) throw leaseError;
      const error = new Error("Runtime status request failed") as Error & {
        status?: number;
      };
      error.status = res.status;
      throw error;
    }

    const json = (await res.json()) as {
      status?: string;
      state?: string;
      progress?: number;
      message?: string;
      framesRendered?: number;
      totalFrames?: number;
      currentScene?: number;
      totalScenes?: number;
      stage?: string;
      quality_report?: unknown;
      qualityAssessment?: unknown;
      error?: string | { title?: string; message?: string; detail?: string; code?: string };
    };
    const rawState = json.status ?? json.state ?? "failed";
    const map: Record<string, RuntimeGenerationStatus["state"]> = {
      pending: "queued",
      queued: "queued",
      starting: "preparing",
      preparing: "preparing",
      processing: "generating",
      running: "generating",
      generating: "generating",
      uploading: "uploading",
      succeeded: "completed",
      success: "completed",
      completed: "completed",
      failed: "failed",
      error: "failed",
      cancelled: "cancelled",
      canceled: "cancelled",
      cancelling: "generating",
    };

    const rawProgress = Number(json.progress ?? 0);
    const normalizedProgress = Number.isFinite(rawProgress) ? rawProgress : 0;
    const scaledProgress =
      this.cfg.payloadMode === "intelligensi-api" && normalizedProgress <= 1
        ? Math.round(normalizedProgress * 10_000) / 100
        : normalizedProgress;
    const progress = Math.min(100, Math.max(0, scaledProgress));
    const state = map[rawState.toLowerCase()] ?? "failed";
    const failureCode =
      typeof json.error === "object" && json.error
        ? safeRuntimeFailureCode(json.error.code)
        : undefined;
    const stage = safeRuntimeStage(json.stage);
    const qualityAssessment = safeQualityAssessment(
      json.quality_report ?? json.qualityAssessment,
    );
    return {
      state,
      progress,
      message: publicRuntimeMessage(state, stage, failureCode),
      ...(state === "failed" && failureCode ? { failureCode } : {}),
      ...optionalPositiveInteger("framesRendered", json.framesRendered),
      ...optionalPositiveInteger("totalFrames", json.totalFrames),
      ...optionalPositiveInteger("currentScene", json.currentScene),
      ...optionalPositiveInteger("totalScenes", json.totalScenes),
      ...(stage ? { stage } : {}),
      ...(qualityAssessment
        ? { qualityAssessment }
        : {}),
    };
  }

  async cancelGeneration(runtimeJobId: string): Promise<RuntimeCancelResult> {
    const path = this.path(
      this.cfg.cancelPath ?? this.defaultPath("cancel"),
      runtimeJobId,
    );
    const res = await this.request(path, { method: "POST" });
    if (!res.ok) return { cancelled: false, accepted: false };
    let state = "";
    let stage = "";
    try {
      const body = (await res.clone().json()) as {
        status?: unknown;
        state?: unknown;
        stage?: unknown;
      };
      state = String(body.status ?? body.state ?? "").toLowerCase();
      stage = String(body.stage ?? "").toLowerCase();
    } catch {
      // A successful but empty response acknowledges the request without
      // proving that the worker has reached a terminal state.
    }
    const cancelled = state === "cancelled" || state === "canceled";
    return {
      cancelled,
      accepted:
        cancelled ||
        state === "cancelling" ||
        state === "canceling" ||
        stage === "cancelling" ||
        stage === "canceling",
    };
  }

  async fetchOutput(runtimeJobId: string): Promise<RuntimeOutput> {
    const path = this.path(
      this.cfg.outputPath ?? this.defaultPath("output"),
      runtimeJobId,
    );
    type RuntimeOutputStatus = {
      output?: string;
      output_url?: string;
      download_url?: string;
      artifact_url?: string;
      durationSeconds?: number;
      duration_seconds?: number;
      settings?: {
        total_output_seconds?: number;
        durationSeconds?: number;
        duration_seconds?: number;
        duration?: number;
      };
    };
    const readStatusOutput = async (): Promise<RuntimeOutputStatus | undefined> => {
      const statusPath = this.path(
        this.cfg.statusPath ?? this.defaultPath("status"),
        runtimeJobId,
      );
      const statusRes = await this.request(statusPath);
      if (!statusRes.ok) return undefined;
      return (await statusRes.json()) as RuntimeOutputStatus;
    };
    const durationFromStatus = (status?: RuntimeOutputStatus) =>
      Number(
        status?.durationSeconds ??
          status?.duration_seconds ??
          status?.settings?.total_output_seconds ??
          status?.settings?.durationSeconds ??
          status?.settings?.duration_seconds ??
          status?.settings?.duration ??
          0,
      );
    const fetchStatusOutput = async (status?: RuntimeOutputStatus) => {
      const outputUrl = status?.output_url ?? status?.download_url ?? status?.artifact_url;
      if (!outputUrl) return undefined;
      const target = /^https?:\/\//i.test(outputUrl)
        ? new URL(outputUrl)
        : new URL(outputUrl, `${this.cfg.baseUrl!.replace(/\/+$/, "")}/`);
      const configuredOrigin = new URL(this.cfg.baseUrl!).origin;
      if (target.origin !== configuredOrigin) {
        throw new Error(
          "Runtime returned an output URL outside its configured origin",
        );
      }
      return fetch(target, {
        headers: this.headers(),
        redirect: "error",
      });
    };
    let res: Response | undefined;
    try {
      res = await this.request(path, {
        headers: {
          accept:
            "video/mp4, video/webm, image/png, image/jpeg, image/webp, application/octet-stream",
        },
      });
    } catch {
      res = undefined;
    }
    let durationSeconds = 0;

    if (res) {
      const leaseError = await runtimeLeaseUnavailableResponse(res);
      if (leaseError) throw leaseError;
    }

    if (!res?.ok) {
      const status = await readStatusOutput();
      if (status) {
        durationSeconds = durationFromStatus(status);
        res = await fetchStatusOutput(status);
        if (!res && status.output) {
          throw new Error(
            `Runtime completed but exposes only a private output path (${status.output}); add GET /jobs/{jobId}/output to the Lambda runtime`,
          );
        }
      }
    }

    if (!res) throw new Error("Sulphur output fetch failed: no runtime output response");
    if (!res.ok)
      throw new Error(`Sulphur output fetch failed: ${await res.text()}`);

    const contentType = (res.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const acceptedTypes = new Set([
      "video/mp4",
      "video/webm",
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/octet-stream",
    ]);
    if (!acceptedTypes.has(contentType)) {
      let detail = contentType || "unknown content type";
      try {
        const json = (await res.clone().json()) as { output?: string };
        if (json.output) detail = `job output is ${json.output}`;
      } catch {
        // Keep the content-type detail.
      }
      throw new Error(
        `Sulphur output endpoint returned an unsupported artifact: ${detail}`,
      );
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const normalizedContentType =
      contentType === "application/octet-stream"
        ? "video/mp4"
        : (contentType as RuntimeOutput["contentType"]);
    assertRuntimeOutputBytes(bytes, normalizedContentType);
    if (!durationSeconds) {
      const status = await readStatusOutput().catch(() => undefined);
      durationSeconds = durationFromStatus(status);
    }

    return {
      bytes,
      contentType: normalizedContentType,
      durationSeconds:
        Number(res.headers.get("x-video-duration-seconds") ?? 0) ||
        durationSeconds,
    };
  }
}

function payloadModeFromEnv(
  value: string | undefined,
): RuntimePayloadMode | undefined {
  return value === "deploy-studio" ||
    value === "sulphur" ||
    value === "intelligensi-api"
    ? value
    : undefined;
}

function videoLabRuntimeApiKey() {
  return (
    process.env.VIDEO_LAB_RUNTIME_API_KEY ??
    process.env.VIDEO_RUNTIME_API_TOKEN
  );
}

export function createRuntimeFromEnv(): VideoRuntimeAdapter {
  return ["sulphur-ltx", "intelligensi-api"].includes(
    process.env.VIDEO_RUNTIME_PROVIDER ?? "",
  )
    ? new SulphurLtxRuntimeAdapter({
        baseUrl: process.env.VIDEO_RUNTIME_BASE_URL,
        token: videoLabRuntimeApiKey(),
        runtimeId: process.env.VIDEO_RUNTIME_ID,
        healthPath: process.env.VIDEO_RUNTIME_HEALTH_PATH,
        submitPath: process.env.VIDEO_RUNTIME_SUBMIT_PATH,
        statusPath: process.env.VIDEO_RUNTIME_STATUS_PATH,
        cancelPath: process.env.VIDEO_RUNTIME_CANCEL_PATH,
        outputPath: process.env.VIDEO_RUNTIME_OUTPUT_PATH,
        authHeaderName: process.env.VIDEO_RUNTIME_AUTH_HEADER,
        authScheme: process.env.VIDEO_RUNTIME_AUTH_SCHEME,
        payloadMode:
          process.env.VIDEO_RUNTIME_PROVIDER === "intelligensi-api"
            ? "intelligensi-api"
            : payloadModeFromEnv(process.env.VIDEO_RUNTIME_PAYLOAD_MODE),
        timeoutMs: boundedInteger(
          process.env.VIDEO_RUNTIME_TIMEOUT_MS,
          120_000,
          1_000,
          15 * 60_000,
        ),
      })
    : new MockVideoRuntimeAdapter();
}
