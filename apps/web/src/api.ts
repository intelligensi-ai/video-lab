import { MAX_STORYBOARD_SCENES } from "@video-lab/contracts";
import type {
  Generation,
  RuntimeStatus,
  StoryboardProject,
  StoryboardProjectSummary,
  StoryboardContinuityBible,
  StoryboardEnhancementRequest,
  StoryboardEnhancementResponse,
} from "@video-lab/contracts";
import { getApiToken } from "./auth.js";

const API = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function api<T>(path: string, init: RequestInit = {}) {
  const token = await getApiToken();
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail ?? body.title ?? r.statusText);
  }
  return r.json() as Promise<T>;
}

export async function fetchGenerationOutput(downloadUrl: string) {
  const token = await getApiToken();
  const path = downloadUrl.startsWith("/api/")
    ? downloadUrl.slice(4)
    : downloadUrl;
  if (!path.startsWith("/v1/generations/") || !path.endsWith("/download")) {
    throw new Error(
      "The generation output address is not a Video Lab address.",
    );
  }
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail ?? body.title ?? response.statusText);
  }
  return response.blob();
}

export type ReferenceRole =
  | "startFrame"
  | "endFrame"
  | "referenceImage"
  | "styleReference"
  | "subjectReference";

export interface SulphurReferenceInput {
  role: ReferenceRole;
  file?: File;
  assetId?: string;
  strength: number;
}

export interface SulphurGenerationPayload {
  prompt: string;
  negativePrompt?: string;
  enhancePrompt: boolean;
  resolution: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  duration: 4 | 8 | 12;
  durationSeconds: 4 | 8 | 12;
  guidance: number;
  cfgGuidance: number;
  frameRate: number;
  motionStrength: number;
  cameraMotion: string;
  frameInfluence: number;
  promptMode: string;
  quality: "draft" | "standard" | "high";
  outputFormat: string;
  references: SulphurReferenceInput[];
}

const strengthAliasByRole: Record<ReferenceRole, string> = {
  startFrame: "startFrameStrength",
  endFrame: "endFrameStrength",
  referenceImage: "referenceImageStrength",
  styleReference: "styleReferenceStrength",
  subjectReference: "subjectReferenceStrength",
};

function fileToDataUrl(file?: File) {
  if (!file) return Promise.resolve(undefined);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function storeUserAsset(file: File | undefined, purpose: string) {
  if (!file) return undefined;
  const normalizedPurpose = purpose.includes("start")
    ? "start_frame"
    : purpose.includes("end")
      ? "end_frame"
      : "reference";
  const target = await api<{
    uploadUrl: string;
    assetId: string;
    method: "PUT";
  }>("/v1/assets/upload-url", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      purpose: normalizedPurpose,
    }),
  });
  const token = await getApiToken();
  const response = await fetch(`${API}${target.uploadUrl}`, {
    method: target.method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": file.type,
    },
    body: file,
  });
  if (!response.ok) throw new Error("The frame upload could not be completed.");
  return target.assetId;
}

export async function generateSulphurVideo(payload: SulphurGenerationPayload) {
  const uploadedAssetIds = await Promise.all(
    payload.references.map((reference) =>
      storeUserAsset(reference.file, reference.role),
    ),
  );
  const references = await Promise.all(
    payload.references.map(async (ref, index) => ({
      ...ref,
      assetId: uploadedAssetIds[index],
      dataUrl: uploadedAssetIds[index]
        ? undefined
        : await fileToDataUrl(ref.file),
    })),
  );
  const dataByRole = Object.fromEntries(
    references
      .filter((ref) => ref.dataUrl)
      .map((ref) => [ref.role, ref.dataUrl]),
  ) as Partial<Record<ReferenceRole, string>>;
  const strengthByRole = Object.fromEntries(
    references.map((ref) => [strengthAliasByRole[ref.role], ref.strength]),
  );
  const assetIdByRole = Object.fromEntries(
    references
      .filter((ref) => ref.assetId)
      .map((ref) => [`${ref.role}AssetId`, ref.assetId]),
  );
  const generation = await api<Generation>("/v1/generations", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: payload.prompt,
      settings: {
        aspectRatio: payload.aspectRatio,
        durationSeconds: payload.durationSeconds,
        quality: payload.quality,
        negativePrompt: payload.negativePrompt,
        enhancePrompt: payload.enhancePrompt,
        resolution: payload.resolution,
        duration: payload.duration,
        guidance: payload.guidance,
        cfgGuidance: payload.cfgGuidance,
        frameRate: payload.frameRate,
        motionStrength: payload.motionStrength,
        cameraMotion: payload.cameraMotion,
        frameInfluence: payload.frameInfluence,
        promptMode: payload.promptMode,
        outputFormat: payload.outputFormat,
        seedFrameBase64: dataByRole.startFrame,
        endFrameBase64: dataByRole.endFrame,
        referenceImageBase64: dataByRole.referenceImage,
        styleReferenceBase64: dataByRole.styleReference,
        subjectReferenceBase64: dataByRole.subjectReference,
        ...strengthByRole,
        ...assetIdByRole,
      },
      inputAssets: [],
    }),
  });
  return generation;
}

export const getRuntimeStatus = () => api<RuntimeStatus>("/v1/runtime/status");
export const getGeneration = (id: string) =>
  api<Generation>(`/v1/generations/${id}`);
export const getGallery = () => api<{ items: Generation[] }>("/v1/gallery");
export const cancelGeneration = (id: string) =>
  api<Generation>(`/v1/generations/${id}/cancel`, { method: "POST" });
export type StoryboardTransition =
  | "cut"
  | "crossfade"
  | "fade_black"
  | "fade_white"
  | "slide_left"
  | "slide_right"
  | "wipe_left"
  | "wipe_right"
  | "zoom_warp"
  | "radial"
  | "blur_dissolve";

export interface StoryboardScenePayload {
  id: string;
  title: string;
  prompt: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
  seed: number;
  seedOverrideEnabled?: boolean;
  summary?: string;
  continuityOverrides?: Partial<StoryboardContinuityBible>;
  transition: StoryboardTransition;
  transitionDuration: number;
  startFrame?: File;
  endFrame?: File;
  carryPreviousFrame: boolean;
  narrativePurpose?: string;
  firstFramePrompt?: string;
  lastFramePrompt?: string;
  continuityNotes?: string;
  promptOrigin?: "user" | "agent";
  staleReason?: string;
  startFrameGenerationId?: string;
  endFrameGenerationId?: string;
  acceptedVideoGenerationId?: string;
}

export interface LongFormGenerationPayload {
  overallGoal: string;
  originalOverallGoal?: string;
  negativePrompt: string;
  resolution: string;
  fps: number;
  imageSteps: number;
  guidanceScale: number;
  startFrameStrength: number;
  endFrameStrength: number;
  enhancePrompt: boolean;
  postProcess: string;
  outputFormat: string;
  globalSeed: number;
  seedPolicy: "global_locked" | "scene_overrides";
  globalVisualAnchorEnabled: boolean;
  globalVisualAnchor?: File;
  scenes: StoryboardScenePayload[];
  continuityBible: StoryboardContinuityBible;
}

export async function generateLongFormVideo(
  payload: LongFormGenerationPayload,
  projectId: string,
) {
  if (payload.scenes.length > MAX_STORYBOARD_SCENES) {
    throw new Error(
      `Storyboard supports up to ${MAX_STORYBOARD_SCENES} scenes per generation.`,
    );
  }
  const [globalVisualAnchorAssetId, ...uploadedSceneAssetIds] =
    await Promise.all([
      storeUserAsset(payload.globalVisualAnchor, "globalVisualAnchor"),
      ...payload.scenes.flatMap((scene) => [
        storeUserAsset(scene.startFrame, `${scene.id}:startFrame`),
        storeUserAsset(scene.endFrame, `${scene.id}:endFrame`),
      ]),
    ]);
  const globalVisualAnchorBase64 =
    payload.globalVisualAnchorEnabled && !globalVisualAnchorAssetId
      ? await fileToDataUrl(payload.globalVisualAnchor)
      : undefined;
  const storyboard = await Promise.all(
    payload.scenes.map(async (scene, index) => {
      const startFrameAssetId = uploadedSceneAssetIds[index * 2];
      const endFrameAssetId = uploadedSceneAssetIds[index * 2 + 1];
      const startFrameBase64 = startFrameAssetId
        ? undefined
        : await fileToDataUrl(scene.startFrame);
      const endFrameBase64 = endFrameAssetId
        ? undefined
        : await fileToDataUrl(scene.endFrame);
      return {
        ...scene,
        startFrame: undefined,
        endFrame: undefined,
        startFrameBase64,
        endFrameBase64,
        startFrameAssetId,
        endFrameAssetId,
        seed: scene.seedOverrideEnabled ? scene.seed : payload.globalSeed,
        seedOverride: scene.seedOverrideEnabled === true,
      };
    }),
  );
  const durationSeconds = storyboard.reduce(
    (total, scene) => total + scene.duration,
    0,
  );
  const generation = await api<Generation>("/v1/generations", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: payload.overallGoal,
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio:
          payload.resolution.startsWith("576x") ||
          payload.resolution.startsWith("720x1280")
            ? "9:16"
            : payload.resolution.startsWith("1080x1080")
              ? "1:1"
              : "16:9",
        durationSeconds,
        quality: payload.postProcess === "none" ? "draft" : "high",
        overallGoal: payload.overallGoal,
        projectId,
        operationScope: "project",
        filmBible: payload.continuityBible,
        negativePrompt: payload.negativePrompt,
        resolution: payload.resolution,
        fps: payload.fps,
        imageSteps: payload.imageSteps,
        guidanceScale: payload.guidanceScale,
        startFrameStrength: payload.startFrameStrength,
        endFrameStrength: payload.endFrameStrength,
        enhancePrompt: payload.enhancePrompt,
        postProcess: payload.postProcess,
        outputFormat: payload.outputFormat,
        seedMode: payload.seedPolicy,
        baseSeed: payload.globalSeed,
        globalVisualAnchorEnabled: payload.globalVisualAnchorEnabled,
        globalVisualAnchorBase64,
        globalVisualAnchorAssetId,
        storyboard,
      },
      inputAssets: [],
    }),
  });
  return generation;
}

export const emptyContinuityBible = (): StoryboardContinuityBible => ({
  characters: "",
  wardrobe: "",
  props: "",
  location: "",
  sceneGeometry: "",
  timeOfDay: "",
  lighting: "",
  palette: "",
  lens: "",
  cameraPosition: "",
  cameraMovement: "",
  visualStyle: "",
  audio: "",
});

export function storyboardEnhancementRequest(
  payload: LongFormGenerationPayload,
  targetShotNumber?: number,
): StoryboardEnhancementRequest {
  return {
    masterPrompt: payload.overallGoal,
    shotCount: payload.scenes.length,
    generationMode: payload.scenes.some(
      (scene) => scene.startFrame || scene.endFrame,
    )
      ? "mixed"
      : "text_to_video",
    continuityBible: payload.continuityBible,
    shots: payload.scenes.map((scene, index) => ({
      shotNumber: index + 1,
      title: scene.title,
      prompt: scene.prompt,
      durationSeconds: scene.duration,
      generationMode:
        scene.startFrame || scene.endFrame ? "image_to_video" : "text_to_video",
    })),
    targetShotNumber,
  };
}

export const enhanceStoryboard = (
  payload: LongFormGenerationPayload,
  targetShotNumber?: number,
) =>
  api<StoryboardEnhancementResponse>("/v1/storyboards/enhance", {
    method: "POST",
    body: JSON.stringify(
      storyboardEnhancementRequest(payload, targetShotNumber),
    ),
  });

export async function generateStoryboardFrame(
  payload: LongFormGenerationPayload,
  scene: StoryboardScenePayload,
  edge: "start" | "end",
  projectId: string,
) {
  const framePrompt =
    (edge === "start"
      ? scene.firstFramePrompt
      : scene.lastFramePrompt
    )?.trim() || scene.prompt;
  const storyboard = [
    {
      id: scene.id,
      title: scene.title,
      prompt: scene.prompt,
      duration: scene.duration,
      trimStart: 0,
      trimEnd: scene.duration,
      seed: scene.seed,
      seedOverride: scene.seedOverrideEnabled === true,
      summary: scene.summary,
      continuityOverrides: scene.continuityOverrides,
      transition: scene.transition,
      transitionDuration: scene.transitionDuration,
      carryPreviousFrame: scene.carryPreviousFrame,
    },
  ];
  return api<Generation>("/v1/generations", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: payload.overallGoal,
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: payload.resolution.includes("x1280")
          ? "9:16"
          : payload.resolution.includes("1080x1080")
            ? "1:1"
            : "16:9",
        durationSeconds: scene.duration,
        quality: "draft",
        projectId,
        operationScope: edge === "start" ? "start_frame" : "end_frame",
        operationSceneId: scene.id,
        framePrompt,
        overallGoal: payload.overallGoal,
        filmBible: payload.continuityBible,
        resolution: payload.resolution,
        imageSteps: payload.imageSteps,
        seedMode: payload.seedPolicy,
        baseSeed: payload.globalSeed,
        storyboard,
      },
      inputAssets: [],
    }),
  });
}

export async function generateStoryboardScene(
  payload: LongFormGenerationPayload,
  scene: StoryboardScenePayload,
  projectId: string,
) {
  const [startFrameAssetId, endFrameAssetId] = await Promise.all([
    storeUserAsset(scene.startFrame, `${scene.id}:startFrame`),
    storeUserAsset(scene.endFrame, `${scene.id}:endFrame`),
  ]);
  const storyboard = [
    {
      ...scene,
      startFrame: undefined,
      endFrame: undefined,
      startFrameAssetId,
      endFrameAssetId,
      seed: scene.seedOverrideEnabled ? scene.seed : payload.globalSeed,
      seedOverride: scene.seedOverrideEnabled === true,
      summary: scene.summary,
      continuityOverrides: scene.continuityOverrides,
    },
  ];
  return api<Generation>("/v1/generations", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: scene.prompt,
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: payload.resolution.includes("x1280")
          ? "9:16"
          : payload.resolution.includes("1080x1080")
            ? "1:1"
            : "16:9",
        durationSeconds: scene.duration,
        quality: payload.postProcess === "none" ? "draft" : "high",
        projectId,
        operationScope: "scene",
        operationSceneId: scene.id,
        overallGoal: payload.overallGoal,
        filmBible: payload.continuityBible,
        negativePrompt: payload.negativePrompt,
        resolution: payload.resolution,
        fps: payload.fps,
        imageSteps: payload.imageSteps,
        guidanceScale: payload.guidanceScale,
        startFrameStrength: payload.startFrameStrength,
        endFrameStrength: payload.endFrameStrength,
        enhancePrompt: payload.enhancePrompt,
        postProcess: "none",
        outputFormat: payload.outputFormat,
        seedMode: payload.seedPolicy,
        baseSeed: payload.globalSeed,
        storyboard,
      },
      inputAssets: [],
    }),
  });
}

export async function assembleStoryboardFilm(
  payload: LongFormGenerationPayload,
  projectId: string,
) {
  const acceptedSceneGenerationIds = payload.scenes.map(
    (scene) => scene.acceptedVideoGenerationId,
  );
  if (acceptedSceneGenerationIds.some((id) => !id))
    throw new Error(
      "Render and accept one clip for every scene before assembly.",
    );
  return api<Generation>("/v1/generations", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      prompt: payload.overallGoal,
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: payload.resolution.includes("x1280")
          ? "9:16"
          : payload.resolution.includes("1080x1080")
            ? "1:1"
            : "16:9",
        durationSeconds: payload.scenes.reduce(
          (total, scene) => total + (scene.trimEnd - scene.trimStart),
          0,
        ),
        quality: payload.postProcess === "none" ? "draft" : "high",
        projectId,
        operationScope: "assembly",
        overallGoal: payload.overallGoal,
        resolution: payload.resolution,
        fps: payload.fps,
        outputFormat: payload.outputFormat,
        acceptedSceneGenerationIds,
        storyboard: payload.scenes.map((scene) => ({
          ...scene,
          startFrame: undefined,
          endFrame: undefined,
          seed: scene.seedOverrideEnabled ? scene.seed : payload.globalSeed,
          seedOverride: scene.seedOverrideEnabled === true,
          summary: scene.summary,
          continuityOverrides: scene.continuityOverrides,
        })),
      },
      inputAssets: [],
    }),
  });
}

export async function waitForGeneration(id: string, timeoutMs = 20 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const generation = await getGeneration(id);
    if (["completed", "failed", "cancelled"].includes(generation.status))
      return generation;
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
  throw new Error(
    "Generation is still running. You can safely return to it from your project history.",
  );
}

export const listStoryboardProjects = () =>
  api<{ items: StoryboardProjectSummary[] }>("/v1/storyboards/projects");

export const getStoryboardProject = (projectId: string) =>
  api<StoryboardProject>(
    `/v1/storyboards/projects/${encodeURIComponent(projectId)}`,
  );

export const createStoryboardProject = (
  title: string,
  form: Record<string, unknown>,
) =>
  api<StoryboardProject>("/v1/storyboards/projects", {
    method: "POST",
    body: JSON.stringify({ title, form }),
  });

export const updateStoryboardProject = (
  projectId: string,
  title: string,
  form: Record<string, unknown>,
) =>
  api<StoryboardProject>(
    `/v1/storyboards/projects/${encodeURIComponent(projectId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ title, form }),
    },
  );

export const deleteStoryboardProject = (projectId: string) =>
  api<{ status: "deletion_scheduled" }>(
    `/v1/storyboards/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );

export const getStoryboardDraft = () =>
  api<{
    form: Partial<LongFormGenerationPayload> | null;
    updatedAt: string | null;
  }>("/v1/storyboards/draft");

export const saveStoryboardDraft = (form: Record<string, unknown>) =>
  api<{ form: Partial<LongFormGenerationPayload>; updatedAt: string }>(
    "/v1/storyboards/draft",
    {
      method: "PUT",
      body: JSON.stringify({ form }),
    },
  );
