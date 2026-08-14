import { MAX_STORYBOARD_SCENES } from "@video-lab/contracts";
import type {
  DirectorProposal,
  DirectorProposalRequest,
  DirectorProposalResult,
  Generation,
  LongFormVideoModel,
  RuntimeStatus,
  StoryboardProject,
  StoryboardProjectSummary,
  StoryboardAudioIntent,
  StoryboardAudioPolicy,
  StoryboardContinuityBible,
  StoryboardEnhancementRequest,
  StoryboardEnhancementOperation,
  StoryboardEnhancementResponse,
  StoryboardReferenceType,
  StoryboardReferencePlanningEvidence,
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
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

export async function fetchGenerationOutput(downloadUrl: string) {
  const token = await getApiToken();
  const path = downloadUrl.startsWith("/api/")
    ? downloadUrl.slice(4)
    : downloadUrl;
  if (
    !/^\/v1\/generations\/[^/]+(?:\/edits\/[^/]+)?\/download$/.test(path)
  ) {
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

export type GenerationEdit = {
  id: string;
  generationId: string;
  startSeconds: number;
  endSeconds: number;
  status: "processing" | "completed" | "failed";
  output?: {
    downloadUrl: string;
    durationSeconds: number;
    contentType: "video/mp4";
    kind: "video";
  };
  safeErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export async function createGenerationEdit(
  generationId: string,
  startSeconds: number,
  endSeconds: number,
) {
  return api<GenerationEdit>(`/v1/generations/${generationId}/edits`, {
    method: "POST",
    body: JSON.stringify({ startSeconds, endSeconds }),
  });
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

export async function storeUserAsset(file: File | undefined, purpose: string) {
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

export async function fetchUserAsset(assetId: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(assetId)) throw new Error("The private reference identifier is invalid.");
  const token = await getApiToken();
  const response = await fetch(`${API}/v1/assets/${encodeURIComponent(assetId)}/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("The private reference could not be loaded.");
  return response.blob();
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
  keyframes?: StoryboardTemporalKeyframePayload[];
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
  candidateGenerationIds?: string[];
  candidateVariations?: string[];
  referenceIds?: string[];
  recommendedControls?: string[];
  audioIntent?: StoryboardAudioIntent;
}

export interface StoryboardTemporalKeyframePayload {
  id: string;
  timeSeconds: number;
  strength: number;
  frame?: File;
  frameAssetId?: string;
}

export const MAX_INTERMEDIATE_KEYFRAMES = 6;

export async function prepareTemporalKeyframes(
  scene: StoryboardScenePayload,
) {
  const keyframes = scene.keyframes ?? [];
  if (keyframes.length > MAX_INTERMEDIATE_KEYFRAMES) {
    throw new Error(
      `A scene supports up to ${MAX_INTERMEDIATE_KEYFRAMES} intermediate frame anchors.`,
    );
  }
  let previousTime = 0;
  const identifiers = new Set<string>();
  return Promise.all(
    keyframes.map(async (keyframe, index) => {
      const unexpected = Object.keys(keyframe).filter(
        (key) => !["id", "timeSeconds", "strength", "frame", "frameAssetId"].includes(key),
      );
      if (unexpected.length) {
        throw new Error(`Intermediate frame ${index + 1} contains unsupported fields.`);
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyframe.id) || identifiers.has(keyframe.id)) {
        throw new Error("Intermediate frame identifiers must be unique and valid.");
      }
      identifiers.add(keyframe.id);
      if (
        !Number.isFinite(keyframe.timeSeconds) ||
        keyframe.timeSeconds <= previousTime ||
        keyframe.timeSeconds >= scene.duration
      ) {
        throw new Error(
          "Intermediate frame times must be ordered and fall inside the scene duration.",
        );
      }
      previousTime = keyframe.timeSeconds;
      if (
        !Number.isFinite(keyframe.strength) ||
        keyframe.strength < 0 ||
        keyframe.strength > 1
      ) {
        throw new Error("Intermediate frame strength must be between 0 and 1.");
      }
      if (
        keyframe.frameAssetId !== undefined &&
        !/^[A-Za-z0-9_-]{8,64}$/.test(keyframe.frameAssetId)
      ) {
        throw new Error("The intermediate frame asset identifier is invalid.");
      }
      const temporalKeyframeAssetId = keyframe.frame
        ? await storeUserAsset(
            keyframe.frame,
            `${scene.id}:temporalKeyframe:${keyframe.id}`,
          )
        : keyframe.frameAssetId;
      if (!temporalKeyframeAssetId && !keyframe.frame) {
        throw new Error(`Intermediate frame ${index + 1} requires an image.`);
      }
      return {
        id: keyframe.id,
        timeSeconds: keyframe.timeSeconds,
        strength: keyframe.strength,
        temporalKeyframeAssetId,
        temporalKeyframeBase64: temporalKeyframeAssetId
          ? undefined
          : await fileToDataUrl(keyframe.frame),
      };
    }),
  );
}

export interface StoryboardProjectReference {
  id: string;
  type: StoryboardReferenceType;
  label: string;
  description: string;
  lockedTraits: string[];
  sceneIds: string[];
  assetId?: string;
  assetVersionIds: string[];
  version: number;
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
  audioPolicy: StoryboardAudioPolicy;
  candidateCount: number;
  projectReferences: StoryboardProjectReference[];
  videoModel?: LongFormVideoModel;
  directorAssumptions?: string[];
  instructionBundle?: StoryboardEnhancementResponse["instructionBundle"];
  referencePlanningEvidence?: StoryboardReferencePlanningEvidence;
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
  const globalVisualAnchorAssetId = await storeUserAsset(
    payload.globalVisualAnchor,
    "globalVisualAnchor",
  );
  const globalVisualAnchorBase64 =
    payload.globalVisualAnchorEnabled && !globalVisualAnchorAssetId
      ? await fileToDataUrl(payload.globalVisualAnchor)
      : undefined;
  const storyboard = await Promise.all(
    payload.scenes.map(async (scene, index) => {
      const [startFrameAssetId, endFrameAssetId, keyframes] = await Promise.all([
        storeUserAsset(scene.startFrame, `${scene.id}:startFrame`),
        storeUserAsset(scene.endFrame, `${scene.id}:endFrame`),
        prepareTemporalKeyframes(scene),
      ]);
      const startFrameBase64 = startFrameAssetId
        ? undefined
        : await fileToDataUrl(scene.startFrame);
      const endFrameBase64 = endFrameAssetId
        ? undefined
        : await fileToDataUrl(scene.endFrame);
      return {
        ...scene,
        prompt:
          scene.prompt.trim() ||
          `Scene ${index + 1}: create a clear cinematic beat that advances this film overview: ${payload.overallGoal}`,
        startFrame: undefined,
        endFrame: undefined,
        startFrameBase64,
        endFrameBase64,
        startFrameAssetId,
        endFrameAssetId,
        keyframes,
        seed: scene.seedOverrideEnabled ? scene.seed : payload.globalSeed,
        seedOverride: scene.seedOverrideEnabled === true,
        carryPreviousFrame: index > 0 && scene.carryPreviousFrame,
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
        videoModel: payload.videoModel ?? "ltx-2.3",
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
        originalMasterPrompt: payload.originalOverallGoal ?? payload.overallGoal,
        audioPolicy: payload.audioPolicy,
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
  projectId?: string,
  operation: StoryboardEnhancementOperation = targetShotNumber
    ? "revise_shot"
    : "plan_storyboard",
): StoryboardEnhancementRequest {
  const clean = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";
  const aspectRatio = payload.resolution.startsWith("576x") || payload.resolution.startsWith("720x1280")
    ? "9:16"
    : payload.resolution.startsWith("1080x1080") ? "1:1" : "16:9";
  return {
    contractVersion: "2",
    projectId,
    operation,
    masterPrompt: clean(payload.overallGoal),
    shotCount: payload.scenes.length,
    generationMode: payload.scenes.some(
      (scene) => scene.startFrame || scene.endFrame,
    )
      ? "mixed"
      : "text_to_video",
    continuityBible: payload.continuityBible,
    aspectRatio,
    resolution: payload.resolution,
    references: payload.projectReferences.map(({ id, type, label, description, lockedTraits, version, sceneIds }) => ({
      id,
      type,
      label,
      description,
      lockedTraits,
      version,
      shotNumbers: sceneIds
        .map((sceneId) => payload.scenes.findIndex((scene) => scene.id === sceneId) + 1)
        .filter((shotNumber) => shotNumber > 0),
    })),
    // The API replaces this with its server-owned capability allow-list.
    availableControls: [],
    audioPolicy: payload.audioPolicy,
    requestedCandidateCount: payload.candidateCount,
    videoModel: payload.videoModel ?? "ltx-2.3",
    shots: payload.scenes.map((scene, index) => ({
      shotNumber: index + 1,
      title: clean(scene.title),
      narrativePurpose: clean(scene.narrativePurpose),
      prompt: clean(scene.prompt),
      firstFramePrompt: clean(scene.firstFramePrompt),
      lastFramePrompt: clean(scene.lastFramePrompt),
      continuityNotes: clean(scene.continuityNotes),
      durationSeconds: scene.duration,
      generationMode:
        scene.startFrame || scene.endFrame ? "image_to_video" : "text_to_video",
      referenceIds: scene.referenceIds ?? [],
      selectedControls: scene.recommendedControls ?? [],
      audioIntent: scene.audioIntent ?? {
        mode: "silent",
        reason: "No scene-specific audio direction has been accepted.",
      },
      carryPreviousFrame: scene.carryPreviousFrame,
      firstFrameAvailable: Boolean(scene.startFrame || scene.startFrameGenerationId),
      lastFrameAvailable: Boolean(scene.endFrame || scene.endFrameGenerationId),
    })),
    targetShotNumber,
  };
}

export const enhanceStoryboard = (
  payload: LongFormGenerationPayload,
  targetShotNumber?: number,
  projectId?: string,
  operation?: StoryboardEnhancementOperation,
) =>
  api<StoryboardEnhancementResponse>("/v1/storyboards/enhance", {
    method: "POST",
    body: JSON.stringify(
      storyboardEnhancementRequest(payload, targetShotNumber, projectId, operation),
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
        videoModel: payload.videoModel ?? "ltx-2.3",
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
        originalMasterPrompt: payload.originalOverallGoal ?? payload.overallGoal,
        audioPolicy: payload.audioPolicy,
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
  const [startFrameAssetId, endFrameAssetId, keyframes] = await Promise.all([
    storeUserAsset(scene.startFrame, `${scene.id}:startFrame`),
    storeUserAsset(scene.endFrame, `${scene.id}:endFrame`),
    prepareTemporalKeyframes(scene),
  ]);
  const storyboard = [
    {
      ...scene,
      startFrame: undefined,
      endFrame: undefined,
      startFrameAssetId,
      endFrameAssetId,
      keyframes,
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
        videoModel: payload.videoModel ?? "ltx-2.3",
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
        originalMasterPrompt: payload.originalOverallGoal ?? payload.overallGoal,
        audioPolicy: payload.audioPolicy,
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
        videoModel: payload.videoModel ?? "ltx-2.3",
        aspectRatio: payload.resolution.includes("x1280")
          ? "9:16"
          : payload.resolution.includes("1080x1080")
            ? "1:1"
            : "16:9",
        durationSeconds: payload.scenes.reduce(
          (total, scene) => total + scene.duration,
          0,
        ),
        quality: payload.postProcess === "none" ? "draft" : "high",
        projectId,
        operationScope: "assembly",
        overallGoal: payload.overallGoal,
        originalMasterPrompt: payload.originalOverallGoal ?? payload.overallGoal,
        audioPolicy: payload.audioPolicy,
        resolution: payload.resolution,
        fps: payload.fps,
        outputFormat: payload.outputFormat,
        postProcess: payload.postProcess,
        acceptedSceneGenerationIds,
        storyboard: payload.scenes.map((scene) => ({
          ...scene,
          startFrame: undefined,
          endFrame: undefined,
          keyframes: undefined,
          trimStart: 0,
          trimEnd: scene.duration,
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

export const createDirectorProposal = (request: DirectorProposalRequest) =>
  api<DirectorProposal>("/v1/storyboards/director/proposals", {
    method: "POST",
    body: JSON.stringify(request),
  });

export const listDirectorProposals = (projectId: string) =>
  api<{ items: DirectorProposal[] }>(
    `/v1/storyboards/director/history?projectId=${encodeURIComponent(projectId)}`,
  );

export const acceptDirectorProposal = (proposalId: string) =>
  api<DirectorProposalResult>(
    `/v1/storyboards/director/proposals/${encodeURIComponent(proposalId)}/accept`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const discardDirectorProposal = (proposalId: string) =>
  api<DirectorProposal>(
    `/v1/storyboards/director/proposals/${encodeURIComponent(proposalId)}/discard`,
    { method: "POST", body: JSON.stringify({}) },
  );

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
