export * from "./generated.js";
export const MAX_STORYBOARD_SCENES = 24;
export const longFormVideoModels = ["ltx-2.3", "ltx-2.5"] as const;
export type LongFormVideoModel = (typeof longFormVideoModels)[number];
export type LongFormVideoModelStatus = "proven" | "preview" | "unavailable";
export interface LongFormVideoModelCapability {
  id: LongFormVideoModel;
  label: string;
  status: LongFormVideoModelStatus;
  available: boolean;
  recommended: boolean;
  workflowModes: Array<"text" | "start" | "start_end" | "multi_keyframe" | "reference">;
  reason?: string;
}
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
  title?: string;
  sceneSummary?: string;
  settings: VideoSettings;
  inputAssets?: unknown[];
  status: GenerationStatus;
  queuePosition?: number;
  progress?: number;
  runtimeMessage?: string;
  runtimeProgress?: {
    framesRendered?: number;
    totalFrames?: number;
    currentScene?: number;
    totalScenes?: number;
    stage?: string;
  };
  qualityAssessment?: {
    version: string;
    advisory: boolean;
    score: number;
    recommendation: "review" | "recommended" | "repair";
    checks: Array<{
      id: string;
      status: "passed" | "failed" | "warning" | "not_evaluated";
      confidence: number;
      detail?: string;
    }>;
  };
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
  failureCode?: string;
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
  generatedTextQualityControlDisabled?: boolean;
  lastHeartbeatAt?: string;
  activeGenerationId?: string;
  queueDepth: number;
  updatedAt: string;
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
    instructionBundle?: {
      directorVersion: string;
      enhancerVersion: string;
      framePromptVersion: string;
      hash: string;
    };
    defaultVideoModel?: LongFormVideoModel;
    videoModels?: LongFormVideoModelCapability[];
  };
  discovery?: {
    source: "deploy-studio" | "environment" | "legacy" | "none";
    state: "connected" | "waiting" | "stale" | "unavailable";
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
  narrativePurpose: string;
  prompt: string;
  firstFramePrompt: string;
  lastFramePrompt: string;
  continuityNotes: string;
  durationSeconds: number;
  generationMode: "text_to_video" | "image_to_video" | "mixed";
  referenceIds: string[];
  selectedControls: string[];
  audioIntent: StoryboardAudioIntent;
  generatedTextIntent: StoryboardGeneratedTextIntent;
  carryPreviousFrame: boolean;
  firstFrameAvailable: boolean;
  lastFrameAvailable: boolean;
}

export type StoryboardEnhancementOperation =
  | "enhance_master_prompt"
  | "plan_storyboard"
  | "revise_shot"
  | "revise_first_frame"
  | "revise_last_frame";

export type StoryboardReferenceType =
  | "character"
  | "location"
  | "product"
  | "style"
  | "voice"
  | "motion";

export interface StoryboardReferenceSummary {
  id: string;
  type: StoryboardReferenceType;
  label: string;
  description: string;
  lockedTraits: string[];
  version: number;
  shotNumbers: number[];
}

/**
 * Server-to-runtime visual input. This envelope is assembled only after the
 * Video Lab API has reloaded the project and authorised the selected asset.
 * It is deliberately absent from the browser-facing enhancement request.
 */
export interface StoryboardVisualReferenceEnvelope {
  referenceId: string;
  referenceType: Exclude<StoryboardReferenceType, "voice">;
  label: string;
  version: number;
  shotNumbers: number[];
  mimeType: "image/jpeg";
  base64: string;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  pixelCount: number;
}

export interface StoryboardEnhancementRuntimeContext {
  correlationId: string;
  visualReferences: StoryboardVisualReferenceEnvelope[];
  textOnlyReferenceIds: string[];
}

export interface StoryboardAudioPolicy {
  mode: "silent" | "intent_only" | "directed";
  dialogue: "off" | "prompted_only" | "on";
  soundEffects: "off" | "intent_only" | "on";
  ambience: "off" | "intent_only" | "on";
  music: "off" | "prompted_or_unambiguous_performance" | "on";
  preserveSourceAudio: boolean;
}

export interface StoryboardAudioIntent {
  mode: "silent" | "dialogue" | "ambience" | "sound_effects" | "music" | "mixed";
  reason: string;
  dialogue?: string;
  ambience?: string;
  soundEffects?: string;
  music?: string;
  silence?: string;
}

export interface StoryboardGeneratedTextPolicy {
  mode: "forbidden" | "prompted_only" | "allowed";
  captions: boolean;
  subtitles: boolean;
  closedCaptions: boolean;
  titleCards: boolean;
  textOverlays: boolean;
  logos: boolean;
  watermarks: boolean;
  signage: "avoid_readable_text" | "incidental" | "allowed";
}

export interface StoryboardGeneratedTextIntent {
  mode: "none" | "environmental" | "explicit_overlay";
  visibleText: string[];
  reason: string;
}

export const defaultGeneratedTextPolicy = (): StoryboardGeneratedTextPolicy => ({
  mode: "forbidden",
  captions: false,
  subtitles: false,
  closedCaptions: false,
  titleCards: false,
  textOverlays: false,
  logos: false,
  watermarks: false,
  signage: "avoid_readable_text",
});

export const forbiddenGeneratedTextNegativePrompt = [
  "captions",
  "subtitles",
  "closed captions",
  "title cards",
  "lower thirds",
  "text overlays",
  "speech bubbles",
  "interface text",
  "readable labels",
  "readable signage",
  "watermarks",
  "logos",
  "random letters",
  "random numbers",
].join(", ");

export interface StoryboardReferenceUsage {
  referenceId: string;
  shotNumbers: number[];
  purpose: string;
}

export interface StoryboardEnhancementRequest {
  contractVersion: "2";
  projectId?: string;
  projectRevision?: string;
  operation: StoryboardEnhancementOperation;
  userInstruction?: string;
  masterPrompt: string;
  shotCount: number;
  generationMode: "text_to_video" | "image_to_video" | "mixed";
  continuityBible: StoryboardContinuityBible;
  shots: StoryboardEnhancementShotInput[];
  targetShotNumber?: number;
  aspectRatio: "16:9" | "9:16" | "1:1";
  resolution: string;
  references: StoryboardReferenceSummary[];
  availableControls: string[];
  audioPolicy: StoryboardAudioPolicy;
  generatedTextPolicy: StoryboardGeneratedTextPolicy;
  requestedCandidateCount: number;
  videoModel?: LongFormVideoModel;
}

export interface EnhancedStoryboardShot {
  shotNumber: number;
  title: string;
  narrativePurpose: string;
  prompt: string;
  firstFramePrompt: string;
  lastFramePrompt: string;
  continuityNotes: string;
  referenceIds: string[];
  recommendedControls: string[];
  audioIntent: StoryboardAudioIntent;
  generatedTextIntent: StoryboardGeneratedTextIntent;
  candidateVariations: string[];
}

export interface StoryboardVisualReferenceAnalysis {
  referenceId: string;
  referenceVersion: number;
  observedTraits: string[];
  continuityGuidance: string;
  declaredVisibleConflicts: string[];
}

export interface StoryboardVisionSummary {
  mode: "planning_only";
  attachedReferenceIds: string[];
  textOnlyReferenceIds: string[];
}

export interface StoryboardReferencePlanningEvidence {
  visualReferenceAnalyses: StoryboardVisualReferenceAnalysis[];
  vision: StoryboardVisionSummary;
  referenceStates: Array<{
    referenceId: string;
    version: number;
    shotNumbers: number[];
  }>;
  instructionBundle: StoryboardEnhancementResponse["instructionBundle"];
  generatedAt: string;
}

export interface StoryboardEnhancementResponse {
  contractVersion: "2";
  polishedMasterPrompt: string;
  negativePrompt: string;
  continuityBible: StoryboardContinuityBible;
  referenceUsagePlan: StoryboardReferenceUsage[];
  assumptions: string[];
  shots: EnhancedStoryboardShot[];
  visualReferenceAnalyses: StoryboardVisualReferenceAnalysis[];
  vision: StoryboardVisionSummary;
  provider: "ollama" | "llama_cpp" | "mock";
  model: string;
  instructionBundle: {
    directorVersion: string;
    enhancerVersion: string;
    framePromptVersion: string;
    hash: string;
  };
}

export type StoryboardAsyncJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type StoryboardAsyncJobStage =
  | "queued"
  | "loading_model"
  | "planning"
  | "validating"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface StoryboardAsyncJobLinks {
  self: string;
  cancel: string | null;
}

export interface StoryboardEnhancementJob {
  id: string;
  kind: "storyboard_enhancement";
  status: StoryboardAsyncJobStatus;
  stage: StoryboardAsyncJobStage;
  projectId?: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  retryAfterSeconds?: number;
  safeErrorMessage?: string;
  result?: StoryboardEnhancementResponse;
  links: StoryboardAsyncJobLinks;
}

export const directorActionTypes = [
  "answer_project_question",
  "suggest_creative_direction",
  "enhance_master_prompt",
  "plan_storyboard",
  "propose_scene_change",
  "propose_frame_prompt_change",
  "restore_original_prompt",
  "undo_prompt_change",
  "assign_project_reference",
  "remove_project_reference",
  "set_audio_policy",
  "generate_first_frame",
  "generate_last_frame",
  "regenerate_frame",
  "restore_frame_version",
  "generate_scene_candidates",
  "accept_candidate",
  "restore_candidate",
  "generate_scene_video",
  "generate_unfinished_scenes",
  "cancel_job",
  "retry_job",
  "explain_failure",
  "prepare_finishing",
  "assemble_project",
  "export_project",
] as const;

export type DirectorActionType = (typeof directorActionTypes)[number];
export type DirectorProposalKind =
  | "answer"
  | "suggestion"
  | "draft_change"
  | "action_request";
export type DirectorExecutionClass = "none" | "text" | "draft" | "final";
export type DirectorProposalState = "pending" | "accepted" | "discarded";

export interface DirectorProposalDiff {
  path: string;
  label: string;
  before?: string;
  after?: string;
}

export interface DirectorProposal {
  id: string;
  projectId: string;
  projectRevision: string;
  kind: DirectorProposalKind;
  action: DirectorActionType;
  state: DirectorProposalState;
  summary: string;
  explanation: string;
  confirmationRequired: boolean;
  executionClass: DirectorExecutionClass;
  affectedSceneIds: string[];
  preserve: string[];
  invalidations: string[];
  diff: DirectorProposalDiff[];
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorProposalRequest {
  projectId: string;
  message: string;
  selectedSceneId?: string;
}

export interface DirectorProposalResult {
  proposal: DirectorProposal;
  project?: StoryboardProject;
}

export interface DirectorProposalJob {
  id: string;
  kind: "director_proposal";
  status: StoryboardAsyncJobStatus;
  stage: StoryboardAsyncJobStage;
  projectId: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  retryAfterSeconds?: number;
  safeErrorMessage?: string;
  result?: DirectorProposal;
  links: StoryboardAsyncJobLinks;
}
