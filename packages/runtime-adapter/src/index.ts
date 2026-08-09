declare const process: { env: Record<string, string | undefined> };
import type { Generation } from "@video-lab/contracts";

export * from "./storyboardEnhancer.js";

function optionalPositiveInteger<K extends string>(key: K, value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0
    ? ({ [key]: number } as Record<K, number>)
    : {};
}

function safeQualityAssessment(value: unknown): Generation["qualityAssessment"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (source.advisory !== true || !Array.isArray(source.checks)) return undefined;
  const recommendation = ["review", "recommended", "repair"].includes(String(source.recommendation))
    ? String(source.recommendation) as "review" | "recommended" | "repair"
    : "review";
  const checks = source.checks.slice(0, 32).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const check = entry as Record<string, unknown>;
    const status = String(check.status);
    const id = String(check.id ?? "").trim();
    if (!id || !["passed", "failed", "warning", "not_evaluated"].includes(status)) return [];
    return [{
      id: id.slice(0, 80),
      status: status as "passed" | "failed" | "warning" | "not_evaluated",
      confidence: Math.min(1, Math.max(0, Number(check.confidence) || 0)),
      ...(typeof check.detail === "string" ? { detail: check.detail.trim().slice(0, 500) } : {}),
    }];
  });
  const score = Math.min(100, Math.max(0, Math.round(Number(source.score) || 0)));
  return { version: String(source.version ?? "media-qc-v2").slice(0, 80), advisory: true, score, recommendation, checks };
}

export interface RuntimeVideoSettings {
  aspectRatio: "16:9" | "9:16" | "1:1";
  durationSeconds: number;
  quality: "draft" | "standard" | "high";
  seed?: number;
  runtime?: string;
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
    startFrameBase64?: string;
    endFrameBase64?: string;
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
    workflowModes: Array<"text" | "start" | "start_end">;
    operationScopes: Array<
      "project" | "scene" | "start_frame" | "end_frame" | "assembly"
    >;
    postProcess: Array<"none" | "interpolate" | "upscale" | "both">;
    startFrame: boolean;
    endFrame: boolean;
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
  framesRendered?: number;
  totalFrames?: number;
  currentScene?: number;
  totalScenes?: number;
  stage?: string;
  qualityAssessment?: Generation["qualityAssessment"];
}

export interface RuntimeCancelResult {
  cancelled: boolean;
}

export interface RuntimeOutput {
  bytes: Uint8Array;
  contentType:
    "video/mp4" | "video/webm" | "image/png" | "image/jpeg" | "image/webp";
  durationSeconds: number;
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
    return { state: "completed", progress: 100 };
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
    const timeoutMs = timeoutOverrideMs ?? this.cfg.timeoutMs ?? 120_000;
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
                carryPreviousFrame: true,
                ...(settings.seedFrameBase64
                  ? { startFrameBase64: settings.seedFrameBase64 }
                  : {}),
                ...(settings.endFrameBase64
                  ? { endFrameBase64: settings.endFrameBase64 }
                  : {}),
              },
            ];

        return {
          project_id: settings.projectId,
          operation_scope: settings.operationScope ?? "project",
          operation_scene_id: settings.operationSceneId,
          frame_prompt: settings.framePrompt,
          operation_frame_base64: settings.operationFrameBase64,
          film_bible: settings.filmBible,
          overall_goal: settings.overallGoal ?? input.prompt,
          original_master_prompt: settings.originalMasterPrompt ?? settings.overallGoal ?? input.prompt,
          audio_policy: settings.audioPolicy,
          prompt: input.prompt,
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
          storyboard: storyboard.map((scene) => ({
            id: scene.id,
            title: scene.title,
            prompt: scene.prompt,
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
            start_frame_base64: scene.startFrameBase64,
            end_frame_base64: scene.endFrameBase64,
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
      capabilities?: {
        workflow_modes?: unknown;
        style_reference?: unknown;
        subject_reference?: unknown;
      };
      advanced_video_controls?: {
        start_frame_supported?: unknown;
        end_frame_supported?: unknown;
      };
      storyboard?: {
        max_scenes?: unknown;
        continuity?: unknown;
        post_process?: unknown;
      };
      runtimeId?: string;
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
      const features = body.features;
      return {
        ok: res.ok && ready === true && body.status === "ready",
        provider: body.runtimeId ?? this.runtimeId(),
        worker: body.runtimeId ?? this.runtimeId(),
        ready,
        capabilities: features,
        message:
          res.ok && ready === true
            ? "healthy"
            : `${res.status} ${res.statusText}`,
      };
    }
    const workflowModes: Array<"text" | "start" | "start_end"> = Array.isArray(
      body.capabilities?.workflow_modes,
    )
      ? body.capabilities.workflow_modes.filter(
          (value): value is "text" | "start" | "start_end" =>
            ["text", "start", "start_end"].includes(String(value)),
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
        featureStatus: {
          startEndFrames: "supported",
          referencePlanning: "partial",
          referenceConditioning: "unavailable",
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
    const res = await this.request(
      this.cfg.submitPath ?? this.defaultPath("submit"),
      {
        method: "POST",
        headers: input.idempotencyKey
          ? { "Idempotency-Key": input.idempotencyKey }
          : undefined,
        body: JSON.stringify(this.payload(input)),
      },
    );

    if (!res.ok) {
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
    const res = await this.request(path);
    if (!res.ok) throw new Error(`Sulphur status failed: ${await res.text()}`);

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
      error?: string | { title?: string; detail?: string; code?: string };
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
    };

    const rawProgress = Number(json.progress ?? 0);
    const progress =
      this.cfg.payloadMode === "intelligensi-api" && rawProgress <= 1
        ? Math.round(rawProgress * 10_000) / 100
        : rawProgress;
    const errorMessage =
      typeof json.error === "string"
        ? json.error
        : json.error?.detail ?? json.error?.title ?? json.error?.code;
    const qualityAssessment = safeQualityAssessment(
      json.quality_report ?? json.qualityAssessment,
    );
    return {
      state: map[rawState.toLowerCase()] ?? "failed",
      progress,
      message: json.message ?? errorMessage,
      ...optionalPositiveInteger("framesRendered", json.framesRendered),
      ...optionalPositiveInteger("totalFrames", json.totalFrames),
      ...optionalPositiveInteger("currentScene", json.currentScene),
      ...optionalPositiveInteger("totalScenes", json.totalScenes),
      ...(typeof json.stage === "string" && json.stage.trim()
        ? { stage: json.stage.trim() }
        : {}),
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
    return { cancelled: res.ok };
  }

  async fetchOutput(runtimeJobId: string): Promise<RuntimeOutput> {
    const path = this.path(
      this.cfg.outputPath ?? this.defaultPath("output"),
      runtimeJobId,
    );
    let res = await this.request(path, {
      headers: {
        accept:
          "video/mp4, video/webm, image/png, image/jpeg, image/webp, application/octet-stream",
      },
    });
    let durationSeconds = 0;

    if (!res.ok && this.cfg.payloadMode === "deploy-studio") {
      const statusPath = this.path(
        this.cfg.statusPath ?? this.defaultPath("status"),
        runtimeJobId,
      );
      const statusRes = await this.request(statusPath);
      if (statusRes.ok) {
        const status = (await statusRes.json()) as {
          output?: string;
          output_url?: string;
          download_url?: string;
          artifact_url?: string;
          settings?: {
            total_output_seconds?: number;
            duration?: number;
          };
        };
        durationSeconds = Number(
          status.settings?.total_output_seconds ??
            status.settings?.duration ??
            0,
        );
        const outputUrl =
          status.output_url ?? status.download_url ?? status.artifact_url;
        if (outputUrl) {
          const target = /^https?:\/\//i.test(outputUrl)
            ? new URL(outputUrl)
            : new URL(outputUrl, `${this.cfg.baseUrl!.replace(/\/+$/, "")}/`);
          const configuredOrigin = new URL(this.cfg.baseUrl!).origin;
          if (target.origin !== configuredOrigin) {
            throw new Error(
              "Runtime returned an output URL outside its configured origin",
            );
          }
          res = await fetch(target, {
            headers: this.headers(),
            redirect: "error",
          });
        } else if (status.output) {
          throw new Error(
            `Runtime completed but exposes only a private output path (${status.output}); add GET /jobs/{jobId}/output to the Lambda runtime`,
          );
        }
      }
    }

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

    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType:
        contentType === "application/octet-stream"
          ? "video/mp4"
          : (contentType as RuntimeOutput["contentType"]),
      durationSeconds:
        Number(res.headers.get("x-video-duration-seconds") ?? 0) ||
        durationSeconds,
    };
  }
}

function numberFromEnv(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
        timeoutMs: numberFromEnv(process.env.VIDEO_RUNTIME_TIMEOUT_MS),
      })
    : new MockVideoRuntimeAdapter();
}
