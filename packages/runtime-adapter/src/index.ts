declare const process: { env: Record<string, string | undefined> };

export * from "./storyboardEnhancer.js";

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
  overallGoal?: string;
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
}

export interface RuntimeGenerationInput {
  prompt: string;
  settings: RuntimeVideoSettings;
  inputAssetUrls?: string[];
}

export interface RuntimeSubmission {
  runtimeJobId: string;
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

type RuntimePayloadMode = "sulphur" | "deploy-studio";

export interface SulphurLtxRuntimeConfig {
  baseUrl?: string | undefined;
  token?: string | undefined;
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
    return template.replaceAll("{jobId}", encodeURIComponent(runtimeJobId));
  }

  private defaultPath(kind: "submit" | "status" | "cancel" | "output") {
    if (this.cfg.payloadMode === "deploy-studio") {
      return {
        submit: "/preview",
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

    const headerName = this.cfg.authHeaderName ?? "authorization";
    const authScheme = this.cfg.authScheme ?? "Bearer";
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

  private payload(input: RuntimeGenerationInput) {
    if (this.cfg.payloadMode === "deploy-studio") {
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
          global_visual_anchor_base64: settings.globalVisualAnchorBase64,
          storyboard: storyboard.map((scene) => ({
            id: scene.id,
            title: scene.title,
            prompt: scene.prompt,
            duration: scene.duration,
            trim_start: scene.trimStart,
            trim_end: scene.trimEnd,
            seed: scene.seed,
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
      this.cfg.healthPath ?? "/health",
      {},
      Math.min(this.cfg.timeoutMs ?? 120_000, 8_000),
    );
    let body: {
      ok?: boolean;
      ready?: boolean;
      worker?: string;
      error?: string | null;
    } = {};
    try {
      body = (await res.clone().json()) as typeof body;
    } catch {
      // Some compatible runtimes expose an empty health response.
    }
    this.detectedWorker = body.worker;
    const ready = body.ready ?? body.ok ?? res.ok;
    return {
      ok: res.ok && ready,
      provider: body.worker ?? "sulphur-ltx",
      worker: body.worker,
      ready,
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
      "/prompt/complete",
      {
        method: "POST",
        body: JSON.stringify({ prompt, mode }),
      },
      Math.max(this.cfg.timeoutMs ?? 120_000, 180_000),
    );
    if (!res.ok)
      throw new Error(`Sulphur prompt completion failed: ${await res.text()}`);
    const result = (await res.json()) as Partial<RuntimePromptCompletion>;
    const completedPrompt = result.completedPrompt?.trim();
    if (!completedPrompt)
      throw new Error("Sulphur prompt completion returned empty text");
    return {
      completedPrompt,
      mode: "expand",
      provider: result.provider ?? "sulphur-gemma",
    };
  }

  async submitGeneration(
    input: RuntimeGenerationInput,
  ): Promise<RuntimeSubmission> {
    const res = await this.request(
      this.cfg.submitPath ?? this.defaultPath("submit"),
      {
        method: "POST",
        body: JSON.stringify(this.payload(input)),
      },
    );

    if (!res.ok)
      throw new Error(`Sulphur submission failed: ${await res.text()}`);
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
      error?: string;
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

    return {
      state: map[rawState.toLowerCase()] ?? "failed",
      progress: json.progress ?? 0,
      message: json.message ?? json.error,
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
      headers: { accept: "video/mp4, application/octet-stream" },
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
  return value === "deploy-studio" || value === "sulphur" ? value : undefined;
}

export function createRuntimeFromEnv(): VideoRuntimeAdapter {
  return process.env.VIDEO_RUNTIME_PROVIDER === "sulphur-ltx"
    ? new SulphurLtxRuntimeAdapter({
        baseUrl: process.env.VIDEO_RUNTIME_BASE_URL,
        token: process.env.VIDEO_RUNTIME_API_TOKEN,
        healthPath: process.env.VIDEO_RUNTIME_HEALTH_PATH,
        submitPath: process.env.VIDEO_RUNTIME_SUBMIT_PATH,
        statusPath: process.env.VIDEO_RUNTIME_STATUS_PATH,
        cancelPath: process.env.VIDEO_RUNTIME_CANCEL_PATH,
        outputPath: process.env.VIDEO_RUNTIME_OUTPUT_PATH,
        authHeaderName: process.env.VIDEO_RUNTIME_AUTH_HEADER,
        authScheme: process.env.VIDEO_RUNTIME_AUTH_SCHEME,
        payloadMode: payloadModeFromEnv(process.env.VIDEO_RUNTIME_PAYLOAD_MODE),
        timeoutMs: numberFromEnv(process.env.VIDEO_RUNTIME_TIMEOUT_MS),
      })
    : new MockVideoRuntimeAdapter();
}
