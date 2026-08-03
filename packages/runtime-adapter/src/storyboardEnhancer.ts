import type {
  EnhancedStoryboardShot,
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
  "shots",
  "provider",
  "model",
]);
const shotKeys = new Set([
  "shotNumber",
  "title",
  "narrativePurpose",
  "prompt",
  "firstFramePrompt",
  "lastFramePrompt",
  "continuityNotes",
]);

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
    };
  });
  return {
    polishedMasterPrompt: text(
      root.polishedMasterPrompt,
      "Polished master prompt",
      12_000,
    ),
    continuityBible,
    shots,
    provider: root.provider === "mock" ? "mock" : "ollama",
    model: text(root.model, "Enhancer model", 120),
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
  const numbers = request.targetShotNumber
    ? [request.targetShotNumber]
    : Array.from({ length: request.shotCount }, (_, index) => index + 1);
  return {
    polishedMasterPrompt: request.masterPrompt,
    continuityBible: request.continuityBible,
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
      };
    }),
    provider: "mock",
    model: "deterministic-test-enhancer",
  };
}
