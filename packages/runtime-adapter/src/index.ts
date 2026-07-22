declare const process: { env: Record<string, string | undefined> };

export interface RuntimeVideoSettings {
  aspectRatio: "16:9" | "9:16" | "1:1";
  durationSeconds: 4 | 8 | 12;
  quality: "draft" | "standard" | "high";
  seed?: number;
}

export interface RuntimeHealth {
  ok: boolean;
  provider: string;
  message?: string;
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
  contentType: "video/mp4";
  durationSeconds: number;
}

export interface VideoRuntimeAdapter {
  healthCheck(): Promise<RuntimeHealth>;
  submitGeneration(input: RuntimeGenerationInput): Promise<RuntimeSubmission>;
  getGenerationStatus(runtimeJobId: string): Promise<RuntimeGenerationStatus>;
  cancelGeneration(runtimeJobId: string): Promise<RuntimeCancelResult>;
  fetchOutput(runtimeJobId: string): Promise<RuntimeOutput>;
}

export class MockVideoRuntimeAdapter implements VideoRuntimeAdapter {
  private jobs = new Map<
    string,
    { created: number; fail?: boolean; cancelled?: boolean }
  >();

  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "mock" };
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

  async fetchOutput(): Promise<RuntimeOutput> {
    return {
      bytes: new TextEncoder().encode("mock mp4 placeholder"),
      contentType: "video/mp4",
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

  private async request(path: string, init: RequestInit = {}) {
    const timeoutMs = this.cfg.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(this.url(path), {
        ...init,
        headers: { ...this.headers(), ...init.headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private payload(input: RuntimeGenerationInput) {
    if (this.cfg.payloadMode === "deploy-studio") {
      const resolution = {
        "16:9": "1280x720",
        "9:16": "720x1280",
        "1:1": "1024x1024",
      }[input.settings.aspectRatio];

      return {
        prompt: input.prompt,
        resolution,
        duration: input.settings.durationSeconds,
        output_format: "mp4",
        seed: input.settings.seed,
        inputAssetUrls: input.inputAssetUrls ?? [],
      };
    }

    return {
      prompt: input.prompt,
      options: input.settings,
      inputAssetUrls: input.inputAssetUrls ?? [],
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    const res = await this.request(this.cfg.healthPath ?? "/health");
    return {
      ok: res.ok,
      provider: "sulphur-ltx",
      message: res.ok ? "healthy" : `${res.status} ${res.statusText}`,
    };
  }

  async submitGeneration(
    input: RuntimeGenerationInput,
  ): Promise<RuntimeSubmission> {
    const res = await this.request(this.cfg.submitPath ?? this.defaultPath("submit"), {
      method: "POST",
      body: JSON.stringify(this.payload(input)),
    });

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
    const res = await this.request(path, {
      headers: { accept: "video/mp4, application/octet-stream" },
    });
    if (!res.ok)
      throw new Error(`Sulphur output fetch failed: ${await res.text()}`);

    const contentType = res.headers.get("content-type") ?? "";
    if (
      !contentType.includes("video/") &&
      !contentType.includes("application/octet-stream")
    ) {
      let detail = contentType || "unknown content type";
      try {
        const json = (await res.clone().json()) as { output?: string };
        if (json.output) detail = `job output is ${json.output}`;
      } catch {
        // Keep the content-type detail.
      }
      throw new Error(
        `Sulphur output endpoint did not return video bytes: ${detail}`,
      );
    }

    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: "video/mp4",
      durationSeconds: Number(res.headers.get("x-video-duration-seconds") ?? 0),
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
