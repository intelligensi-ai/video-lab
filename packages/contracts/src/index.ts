export * from "./generated.js";
export const MAX_STORYBOARD_SCENES = 24;
export const generationStatuses = [
  "queued",
  "preparing",
  "generating",
  "uploading",
  "completed",
  "failed",
  "cancelled",
] as const;
export type GenerationStatus = (typeof generationStatuses)[number];
export interface VideoSettings {
  aspectRatio: "16:9" | "9:16" | "1:1";
  durationSeconds: number;
  quality: "draft" | "standard" | "high";
  seed?: number;
  [key: string]: unknown;
}
export interface Generation {
  id: string;
  prompt: string;
  settings: VideoSettings;
  inputAssets?: unknown[];
  status: GenerationStatus;
  queuePosition?: number;
  progress?: number;
  runtimeMessage?: string;
  creditCost: number;
  output?: {
    downloadUrl?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
    contentType?:
      "video/mp4" | "video/webm" | "image/png" | "image/jpeg" | "image/webp";
    kind?: "video" | "frame";
  };
  safeErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
export interface CreditWallet {
  uid: string;
  available: number;
  reserved: number;
  spent: number;
  updatedAt: string;
  version: number;
}
export interface Me {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string;
  status: "active" | "suspended";
  roles: string[];
  termsVersion: string;
  trialGrantedAt?: string;
}
export interface RuntimeStatus {
  provider: string;
  status: "healthy" | "degraded" | "unavailable" | "paused";
  acceptingSubmissions: boolean;
  killSwitch: boolean;
  lastHeartbeatAt?: string;
  activeGenerationId?: string;
  queueDepth: number;
  updatedAt: string;
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
  };
  discovery?: {
    source: "deploy-studio" | "environment" | "legacy" | "none";
    state: "connected" | "waiting" | "stale" | "unavailable";
    baseUrl?: string;
    leaseExpiresAt?: string;
    lastPublishedAt?: string;
    message?: string;
  };
}

export interface StoryboardProjectSummary {
  id: string;
  title: string;
  sceneCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardProject extends StoryboardProjectSummary {
  form: Record<string, unknown>;
}

export interface StoryboardContinuityBible {
  characters: string;
  wardrobe: string;
  props: string;
  location: string;
  sceneGeometry: string;
  timeOfDay: string;
  lighting: string;
  palette: string;
  lens: string;
  cameraPosition: string;
  cameraMovement: string;
  visualStyle: string;
  audio: string;
}

export interface StoryboardEnhancementShotInput {
  shotNumber: number;
  title: string;
  prompt: string;
  durationSeconds: number;
  generationMode: "text_to_video" | "image_to_video" | "mixed";
}

export interface StoryboardEnhancementRequest {
  masterPrompt: string;
  shotCount: number;
  generationMode: "text_to_video" | "image_to_video" | "mixed";
  continuityBible: StoryboardContinuityBible;
  shots: StoryboardEnhancementShotInput[];
  targetShotNumber?: number;
}

export interface EnhancedStoryboardShot {
  shotNumber: number;
  title: string;
  narrativePurpose: string;
  prompt: string;
  firstFramePrompt: string;
  lastFramePrompt: string;
  continuityNotes: string;
}

export interface StoryboardEnhancementResponse {
  polishedMasterPrompt: string;
  continuityBible: StoryboardContinuityBible;
  shots: EnhancedStoryboardShot[];
  provider: "ollama" | "mock";
  model: string;
}
