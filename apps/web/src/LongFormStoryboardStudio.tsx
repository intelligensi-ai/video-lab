import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  defaultGeneratedTextPolicy,
  MAX_STORYBOARD_SCENES,
} from "@video-lab/contracts";
import type {
  DirectorProposalResult,
  Generation,
  LongFormVideoModel,
  StoryboardGeneratedTextPolicy,
  StoryboardProjectSummary,
} from "@video-lab/contracts";
import {
  assembleStoryboardFilm,
  acceptDirectorProposal,
  cancelGeneration,
  clearPendingStoryboardProjectJobs,
  createCreatorDirectorProposal,
  createDirectorProposal,
  createStoryboardProject,
  deleteStoryboardProject,
  emptyContinuityBible,
  fetchGenerationOutput,
  generateStoryboardFrame,
  generateStoryboardScene,
  generateLongFormVideo,
  getGallery,
  getGeneration,
  getRuntimeStatus,
  getStoryboardDraft,
  listStoryboardProjects,
  fetchUserAsset,
  resumePendingDirectorProposal,
  storeUserAsset,
  storyboardAsyncProgressMessage,
  waitForGeneration,
  type LongFormGenerationPayload,
  type ReferenceRole,
  type StoryboardScenePayload,
  type StoryboardProjectReference,
  type StoryboardTransition,
} from "./api.js";
import {
  AuthenticatedVideo,
  VideoRetrievalMark,
  useAuthenticatedVideo,
} from "./AuthenticatedVideo.js";
import { PromptSuggestion } from "./PromptSuggestion.js";
import { getFirebaseUser, isProductionFirebase } from "./auth.js";
import {
  deleteStoryboardSession,
  loadStoryboardSession,
  saveStoryboardSession,
} from "./storyboardSession.js";
import { runtimeProgressCounter } from "./runtimeProgress.js";
import {
  defaultLongFormVideoModelForRuntime,
  longFormVideoModelLabel,
  longFormVideoModelAvailable,
  longFormVideoModelsForRuntime,
  longFormProjectHasRenderedVideo,
  prepareLongFormVideoModelSwitch,
} from "./longFormVideoModels.js";

type LongFormReference = {
  label: string;
  role: ReferenceRole;
  file?: File;
  preview?: string;
  strength: number;
  helper: string;
};

const UPSCALE_POST_PROCESS_MODES = new Set(["upscale", "both"]);

function postProcessUpscaleEnabled(postProcess: string) {
  return UPSCALE_POST_PROCESS_MODES.has(postProcess);
}

function postProcessSupportsUpscale(postProcess?: string[]) {
  return !postProcess || postProcess.includes("upscale") || postProcess.includes("both");
}

const transitionOptions: Array<{
  value: StoryboardTransition;
  label: string;
  description: string;
  glyph: string;
}> = [
  {
    value: "cut",
    label: "Cut",
    description: "Immediate editorial cut",
    glyph: "┃",
  },
  {
    value: "crossfade",
    label: "Cross fade",
    description: "Blend both scenes together",
    glyph: "◩",
  },
  {
    value: "fade_black",
    label: "Fade through black",
    description: "Cinematic passage of time",
    glyph: "◐",
  },
  {
    value: "fade_white",
    label: "Fade through white",
    description: "Bright flash transition",
    glyph: "◑",
  },
  {
    value: "slide_left",
    label: "Slide left",
    description: "Next scene pushes left",
    glyph: "←",
  },
  {
    value: "slide_right",
    label: "Slide right",
    description: "Next scene pushes right",
    glyph: "→",
  },
  {
    value: "wipe_left",
    label: "Wipe left",
    description: "Hard edge sweeps left",
    glyph: "◧",
  },
  {
    value: "wipe_right",
    label: "Wipe right",
    description: "Hard edge sweeps right",
    glyph: "◨",
  },
  {
    value: "zoom_warp",
    label: "Zoom warp",
    description: "Fast lens push between shots",
    glyph: "◎",
  },
  {
    value: "radial",
    label: "Radial reveal",
    description: "Circular iris transition",
    glyph: "◉",
  },
  {
    value: "blur_dissolve",
    label: "Blur dissolve",
    description: "Soft defocus and resolve",
    glyph: "✣",
  },
];

type MinimalAspectRatio = "16:9" | "9:16" | "1:1";

const minimalResolutionOptions: Record<
  MinimalAspectRatio,
  Array<{ value: string; label: string }>
> = {
  "16:9": [
    { value: "1024x576", label: "1024 × 576" },
    { value: "1280x720", label: "1280 × 720" },
  ],
  "9:16": [
    { value: "576x1024", label: "576 × 1024" },
    { value: "720x1280", label: "720 × 1280" },
  ],
  "1:1": [{ value: "1080x1080", label: "1080 × 1080" }],
};

function minimalAspectRatio(resolution: string): MinimalAspectRatio {
  if (resolution === "576x1024" || resolution === "720x1280") return "9:16";
  if (resolution === "1080x1080") return "1:1";
  return "16:9";
}

function resolutionForAspectRatio(
  aspectRatio: MinimalAspectRatio,
  currentResolution: string,
) {
  const options = minimalResolutionOptions[aspectRatio];
  const prefersStandard =
    currentResolution === "1024x576" || currentResolution === "576x1024";
  return options[prefersStandard ? 0 : options.length - 1].value;
}

const initialScenes: StoryboardScenePayload[] = [
  {
    id: "scene-1",
    title: "Scene 1",
    prompt: "",
    duration: 4,
    trimStart: 0,
    trimEnd: 4,
    seed: 1337,
    seedOverrideEnabled: false,
    summary: "",
    continuityOverrides: {},
    transition: "cut",
    transitionDuration: 0.75,
    carryPreviousFrame: false,
  },
  {
    id: "scene-2",
    title: "Scene 2",
    prompt: "",
    duration: 5,
    trimStart: 0,
    trimEnd: 5,
    seed: 1338,
    seedOverrideEnabled: false,
    summary: "",
    continuityOverrides: {},
    transition: "crossfade",
    transitionDuration: 0.75,
    carryPreviousFrame: true,
  },
];
function seedScenes(isClassic: boolean): StoryboardScenePayload[] {
  const scenes = initialScenes.slice(0, isClassic ? 1 : initialScenes.length);
  return isClassic ? scenes.map((scene) => ({ ...scene, title: "" })) : scenes;
}

const MAX_CREATOR_DURATION_SECONDS = 24;
const MAX_CREATOR_SCENES = 3;

/**
 * Converts the Creator's single total-length choice into the smallest valid
 * storyboard. Application code owns the count and durations; the Director
 * fills the creative content for those exact scenes.
 */
export function creatorScenesForTotalDuration(
  scenes: StoryboardScenePayload[],
  requestedSeconds: number,
  globalSeed: number,
  maxScenes = MAX_CREATOR_SCENES,
): StoryboardScenePayload[] {
  const boundedMaxScenes = Math.max(1, Math.min(MAX_CREATOR_SCENES, maxScenes));
  const totalSeconds = Math.max(
    1,
    Math.min(
      MAX_CREATOR_DURATION_SECONDS,
      boundedMaxScenes * 8,
      Math.round(requestedSeconds),
    ),
  );
  const sceneCount = Math.ceil(totalSeconds / 8);
  const baseDuration = Math.floor(totalSeconds / sceneCount);
  const remainder = totalSeconds % sceneCount;
  const durations = Array.from(
    { length: sceneCount },
    (_, index) => baseDuration + (index < remainder ? 1 : 0),
  );

  return durations.map((duration, index) => {
    const existing = scenes[index];
    if (existing) {
      return {
        ...existing,
        duration,
        trimStart: 0,
        trimEnd: duration,
      };
    }
    return {
      id: crypto.randomUUID(),
      title: "",
      prompt: "",
      duration,
      trimStart: 0,
      trimEnd: duration,
      seed: globalSeed + index,
      seedOverrideEnabled: false,
      summary: "",
      continuityOverrides: {},
      transition: index === 0 ? "cut" : "crossfade",
      transitionDuration: 0.75,
      carryPreviousFrame: index > 0,
      generatedTextIntent: {
        mode: "none",
        visibleText: [],
        reason: "Visible generated text is disabled for the Creator launch workflow.",
      },
    };
  });
}

export function acceptedGenerationRequiresConfirmation(
  generation?: Pick<Generation, "status" | "output">,
) {
  return generation?.status === "completed" && Boolean(generation.output?.downloadUrl);
}

const formatPresets: Array<{
  key: string;
  label: string;
  sublabel: string;
  resolution: string;
  fps: number;
  platform: "youtube" | "tiktok" | "instagram";
}> = [
  {
    key: "landscape",
    label: "YouTube",
    sublabel: "Landscape 16:9",
    resolution: "1280x720",
    fps: 24,
    platform: "youtube",
  },
  {
    key: "square",
    label: "Instagram",
    sublabel: "Square 1:1",
    resolution: "1080x1080",
    fps: 30,
    platform: "instagram",
  },
  {
    key: "portrait",
    label: "TikTok",
    sublabel: "Portrait 9:16",
    resolution: "720x1280",
    fps: 30,
    platform: "tiktok",
  },
];

function SocialIcon({
  platform,
}: {
  platform: "youtube" | "tiktok" | "instagram";
}) {
  if (platform === "youtube") {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="4.5" width="20" height="15" rx="4.5" fill="#FF0033" />
        <path d="M10 8.6l6 3.4-6 3.4z" fill="#fff" />
      </svg>
    );
  }
  if (platform === "tiktok") {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="20" height="20" rx="6" fill="#0A0A0A" />
        <path
          d="M14.6 6.2c.5 1.4 1.6 2.4 3.1 2.6v2.2a5.3 5.3 0 0 1-3.1-1v4.6a4 4 0 1 1-4-4c.2 0 .4 0 .6.03v2.2a1.9 1.9 0 1 0 1.3 1.8V6.2h2.1z"
          fill="#25F4EE"
        />
        <path
          d="M14.1 6.2c.5 1.4 1.6 2.4 3.1 2.6v2.2a5.3 5.3 0 0 1-3.1-1v4.6a4 4 0 1 1-4-4c.2 0 .4 0 .6.03v2.2a1.9 1.9 0 1 0 1.3 1.8V6.2h2.1z"
          fill="#FE2C55"
          opacity="0.75"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="ig-grad" x1="0" y1="24" x2="24" y2="0">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset="0.35" stopColor="#FA7E1E" />
          <stop offset="0.65" stopColor="#D62976" />
          <stop offset="1" stopColor="#962FBF" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#ig-grad)" />
      <rect
        x="6.5"
        y="6.5"
        width="11"
        height="11"
        rx="3.5"
        stroke="#fff"
        strokeWidth="1.6"
        fill="none"
      />
      <circle cx="12" cy="12" r="3" stroke="#fff" strokeWidth="1.6" fill="none" />
      <circle cx="16.3" cy="7.7" r="1" fill="#fff" />
    </svg>
  );
}

const DEFAULT_SCENE_SEED = 1337;
const continuityFields = [
  ["characters", "Characters"],
  ["wardrobe", "Wardrobe"],
  ["props", "Props"],
  ["location", "Locations"],
  ["sceneGeometry", "Scene geography"],
  ["timeOfDay", "Time of day"],
  ["lighting", "Lighting"],
  ["palette", "Colour palette"],
  ["lens", "Lens language"],
  ["cameraPosition", "Camera position"],
  ["cameraMovement", "Camera movement"],
  ["visualStyle", "Visual style"],
  ["audio", "Audio"],
] as const;

type SceneSoundTabKey = "dialogue" | "ambience" | "soundEffects" | "music" | "silence";

const sceneSoundTabs: Array<{
  key: SceneSoundTabKey;
  label: string;
  mode: NonNullable<LongFormGenerationPayload["scenes"][number]["audioIntent"]>["mode"];
  placeholder: string;
}> = [
  {
    key: "dialogue",
    label: "Dialogue",
    mode: "dialogue",
    placeholder: "Lines, spoken intent, delivery style, or note that dialogue should be implied rather than visible as captions.",
  },
  {
    key: "ambience",
    label: "Ambience",
    mode: "ambience",
    placeholder: "Background bed: room tone, crowd wash, wind, water, traffic, space, distance.",
  },
  {
    key: "soundEffects",
    label: "Effects",
    mode: "sound_effects",
    placeholder: "Specific diegetic actions: doors, footsteps, impacts, UI bleeps, machinery, Foley.",
  },
  {
    key: "music",
    label: "Music",
    mode: "music",
    placeholder: "Score/performance direction, genre, intensity, cue timing, or state that music must be absent.",
  },
  {
    key: "silence",
    label: "Silence",
    mode: "silent",
    placeholder: "When and why to keep the scene silent, muted, or restrained.",
  },
];

function sceneSoundTabForIntent(
  scene: Pick<StoryboardScenePayload, "audioIntent">,
): SceneSoundTabKey {
  const mode = scene.audioIntent?.mode;
  if (mode === "silent") return "silence";
  if (mode === "ambience") return "ambience";
  if (mode === "sound_effects") return "soundEffects";
  if (mode === "music") return "music";
  if (mode === "dialogue") return "dialogue";
  if (mode === "mixed") {
    return (
      sceneSoundTabs.find(
        (tab) =>
          tab.key !== "silence" &&
          Boolean(String(scene.audioIntent?.[tab.key] ?? "").trim()),
      )?.key ?? "dialogue"
    );
  }
  return "dialogue";
}

const initialForm: LongFormGenerationPayload = {
  overallGoal: "",
  negativePrompt: "",
  resolution: "1280x720",
  fps: 24,
  imageSteps: 4,
  guidanceScale: 1,
  startFrameStrength: 1,
  endFrameStrength: 0.85,
  enhancePrompt: true,
  postProcess: "none",
  outputFormat: "mp4",
  globalSeed: DEFAULT_SCENE_SEED,
  seedPolicy: "global_locked",
  globalVisualAnchorEnabled: false,
  scenes: initialScenes,
  continuityBible: emptyContinuityBible(),
  audioPolicy: {
    mode: "intent_only",
    dialogue: "prompted_only",
    soundEffects: "on",
    ambience: "on",
    music: "prompted_or_unambiguous_performance",
    preserveSourceAudio: false,
  },
  generatedTextPolicy: defaultGeneratedTextPolicy(),
  candidateCount: 3,
  projectReferences: [],
  videoModel: "ltx-2.3",
};

const freshInitialForm = (): LongFormGenerationPayload =>
  globalThis.structuredClone(initialForm);

function generatedTextPolicyForNoText(
  enabled: boolean,
): StoryboardGeneratedTextPolicy {
  return enabled
    ? defaultGeneratedTextPolicy()
    : {
        mode: "allowed",
        captions: false,
        subtitles: false,
        closedCaptions: false,
        titleCards: false,
        textOverlays: false,
        logos: false,
        watermarks: false,
        signage: "allowed",
      };
}

function factoryFormForStudioVariant(isClassic: boolean): LongFormGenerationPayload {
  return {
    ...freshInitialForm(),
    scenes: seedScenes(isClassic),
  };
}

function normalizePersistedForm(
  saved: LongFormGenerationPayload,
): LongFormGenerationPayload {
  return {
    ...freshInitialForm(),
    ...saved,
    videoModel: saved.videoModel === "ltx-2.5" ? "ltx-2.5" : "ltx-2.3",
    audioPolicy: saved.audioPolicy ?? freshInitialForm().audioPolicy,
    generatedTextPolicy: defaultGeneratedTextPolicy(),
    candidateCount: Math.min(4, Math.max(1, saved.candidateCount ?? 3)),
    projectReferences: (saved.projectReferences ?? []).map((reference) => {
      const assetVersionIds = reference.assetVersionIds?.length
        ? [...new Set(reference.assetVersionIds)]
        : reference.assetId
          ? [reference.assetId]
          : [];
      return {
        ...reference,
        assetVersionIds,
        version: reference.version ?? Math.max(1, assetVersionIds.length),
        sceneIds: reference.sceneIds ?? [],
        lockedTraits: reference.lockedTraits ?? [],
      };
    }),
  };
}

export function formForStudioVariant(
  saved: LongFormGenerationPayload,
  isClassic: boolean,
): LongFormGenerationPayload {
  const normalized = normalizePersistedForm(saved);
  const scenes = normalized.scenes.length
    ? normalized.scenes.slice(0, MAX_STORYBOARD_SCENES).map((scene) => ({
        ...scene,
        trimStart: Number.isFinite(scene.trimStart) ? scene.trimStart : 0,
        trimEnd: Number.isFinite(scene.trimEnd)
          ? scene.trimEnd
          : scene.duration,
        summary: scene.summary ?? "",
        continuityOverrides: scene.continuityOverrides ?? {},
        seedOverrideEnabled: scene.seedOverrideEnabled === true,
        generatedTextIntent: scene.generatedTextIntent ?? {
          mode: "none",
          visibleText: [],
          reason: "Visible generated text is disabled for the Creator launch workflow.",
        },
      }))
    : seedScenes(isClassic);
  return {
    ...normalized,
    videoModel: isClassic ? "ltx-2.3" : normalized.videoModel,
    scenes,
  };
}

export function generationPayloadForStudioVariant(
  form: LongFormGenerationPayload,
  isClassic: boolean,
): LongFormGenerationPayload {
  const overallGoal = form.overallGoal;
  const creatorPrompt = overallGoal.trim();
  const generatedTextPolicy =
    form.generatedTextPolicy ?? defaultGeneratedTextPolicy();
  return {
    ...form,
    overallGoal,
    videoModel: isClassic ? "ltx-2.3" : form.videoModel,
    generatedTextPolicy,
    scenes: form.scenes.map((scene, index) => ({
      ...scene,
      prompt: isClassic && index === 0 ? creatorPrompt : scene.prompt,
      generatedTextIntent:
        generatedTextPolicy.mode === "forbidden"
          ? {
              mode: "none",
              visibleText: [],
              reason:
                "Visible generated text is disabled for the Creator launch workflow.",
            }
          : scene.generatedTextIntent,
    })),
  };
}

// Setting changes made here (resolution, fps, negative prompt, per-scene
// direction, etc.) are captured fresh for the next render; they no longer
// invalidate clips already accepted from a prior render, since assembly
// normalizes resolution/fps per clip (see server-side assembly handling).
function markAcceptedClipsStale(
  form: LongFormGenerationPayload,
  _staleReason: string,
): LongFormGenerationPayload {
  return form;
}

async function hydrateGeneratedFrameFiles(form: LongFormGenerationPayload) {
  const scenes = await Promise.all(
    form.scenes.map(async (scene) => {
      const hydrate = async (
        generationId: string | undefined,
        current: File | undefined,
        edge: "start" | "end",
      ) => {
        if (current || !generationId) return current;
        try {
          const generation = await getGeneration(generationId);
          if (
            generation.status !== "completed" ||
            !generation.output?.downloadUrl ||
            generation.output.kind !== "frame"
          )
            return undefined;
          const blob = await fetchGenerationOutput(
            generation.output.downloadUrl,
          );
          if (!blob.type.startsWith("image/")) return undefined;
          const extension =
            blob.type === "image/jpeg"
              ? "jpg"
              : blob.type === "image/webp"
                ? "webp"
                : "png";
          return new File([blob], `${scene.id}-${edge}-frame.${extension}`, {
            type: blob.type,
          });
        } catch {
          return undefined;
        }
      };
      const [startFrame, endFrame] = await Promise.all([
        hydrate(scene.startFrameGenerationId, scene.startFrame, "start"),
        hydrate(scene.endFrameGenerationId, scene.endFrame, "end"),
      ]);
      return { ...scene, startFrame, endFrame };
    }),
  );
  return { ...form, scenes };
}

type EnhancementAction = {
  apply: "all" | "master" | "shot";
  targetShotNumber?: number;
};

type DirectorRepairAction = {
  message: string;
  selectedSceneId?: string;
};

function mergeServerForm(
  current: LongFormGenerationPayload,
  remote: Record<string, unknown>,
) {
  const normalized = normalizePersistedForm(
    remote as unknown as LongFormGenerationPayload,
  );
  return {
    ...normalized,
    scenes: normalized.scenes.map((scene) => {
      const local = current.scenes.find((candidate) => candidate.id === scene.id);
      return local
        ? {
            ...scene,
            startFrame: local.startFrame,
            endFrame: local.endFrame,
            keyframes: (scene.keyframes ?? []).map((keyframe) => ({
              ...keyframe,
              frame: local.keyframes?.find(
                (candidate) => candidate.id === keyframe.id,
              )?.frame,
            })),
          }
        : scene;
    }),
  };
}

type FrameState = {
  status: "idle" | "queued" | "generating" | "failed";
  error?: string;
};
type SceneRenderState = FrameState;

export default function LongFormStoryboardStudio({
  variant = "advanced",
}: {
  variant?: "advanced" | "classic";
}) {
  const isClassic = variant === "classic";
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => factoryFormForStudioVariant(isClassic));
  const [history, setHistory] = useState<Generation[]>([]);
  const [selected, setSelected] = useState<Generation>();
  const [preservedGeneration, setPreservedGeneration] = useState<Generation>();
  const autoSelectedRef = useRef(true);
  const pinSelected = (generation: Generation) => {
    autoSelectedRef.current = false;
    setSelected(generation);
  };
  const [helpMode, setHelpMode] = useState(false);
  const [sessionOwner, setSessionOwner] = useState("");
  const [projects, setProjects] = useState<StoryboardProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectTitle, setProjectTitle] = useState("Untitled film");
  const [projectError, setProjectError] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [enhancementProgress, setEnhancementProgress] = useState("");
  const [undoForm, setUndoForm] = useState<LongFormGenerationPayload>();
  const resumedDirectorJobRef = useRef("");
  const [frameStates, setFrameStates] = useState<Record<string, FrameState>>(
    {},
  );
  const [previewBatchBusy, setPreviewBatchBusy] = useState(false);
  const [sceneRenderStates, setSceneRenderStates] = useState<
    Record<string, SceneRenderState>
  >({});
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<
    "loading" | "saving" | "saved" | "error"
  >("loading");
  const runtime = useQuery({
    queryKey: ["runtime"],
    queryFn: getRuntimeStatus,
  });
  const gallery = useQuery({ queryKey: ["gallery"], queryFn: getGallery });
  const preserveAcceptedGeneration = () => {
    if (!acceptedGenerationRequiresConfirmation(selected)) return;
    setPreservedGeneration(selected);
    setHistory((items) =>
      items.some((item) => item.id === selected.id)
        ? items
        : [selected, ...items].slice(0, 8),
    );
  };
  const mutation = useMutation({
    onMutate: preserveAcceptedGeneration,
    mutationFn: () => {
      if (!projectId) throw new Error("Choose a project before rendering.");
      return generateLongFormVideo(
        generationPayloadForStudioVariant(form, isClassic),
        projectId,
      );
    },
    onSuccess: (generation) => {
      pinSelected(generation);
      setHistory((items) => [generation, ...items].slice(0, 8));
    },
  });
  const assembly = useMutation({
    onMutate: preserveAcceptedGeneration,
    mutationFn: () => {
      if (!projectId) throw new Error("Choose a project before assembling.");
      return assembleStoryboardFilm(form, projectId);
    },
    onSuccess: (generation) => {
      pinSelected(generation);
      setHistory((items) => [generation, ...items].slice(0, 8));
    },
  });
  const runDirectorProposal = async (
    message: string,
    selectedSceneId?: string,
  ): Promise<DirectorProposalResult> => {
    if (!projectId || !sessionOwner) {
      throw new Error("Open a saved project before asking the Director.");
    }
    await saveStoryboardSession(sessionOwner, projectId, projectTitle, form);
    const submitDirectorProposal = isClassic
      ? createCreatorDirectorProposal
      : createDirectorProposal;
    const proposal = await submitDirectorProposal(
      { projectId, message, selectedSceneId },
      {
        onProgress: (job) =>
          setEnhancementProgress(storyboardAsyncProgressMessage(job)),
      },
    );
    return acceptDirectorProposal(proposal.id);
  };
  const enhancement = useMutation({
    mutationFn: (action: EnhancementAction) => {
      const selectedScene =
        action.targetShotNumber !== undefined
          ? form.scenes[action.targetShotNumber - 1]
          : undefined;
      const message =
        action.apply === "master"
          ? "Polish the master creative brief and continuity bible without changing the scene count."
          : action.apply === "shot" && action.targetShotNumber
            ? `Improve scene ${action.targetShotNumber} with the Director without changing continuity-critical details.`
            : `Plan this creative brief into exactly ${form.scenes.length} scenes while preserving my intent.`;
      return runDirectorProposal(message, selectedScene?.id);
    },
    onSuccess: (result, action) => {
      setUndoForm(form);
      if (result.project) {
        setForm((current) => mergeServerForm(current, result.project!.form));
      }
      setEnhancementProgress(
        action.apply === "shot"
          ? "Director scene update applied."
          : "Director update applied.",
      );
    },
    onSettled: () => setEnhancementProgress(""),
  });
  const classicBriefEnhancement = useMutation({
    mutationFn: () =>
      runDirectorProposal(
        `Plan this creative brief into exactly ${form.scenes.length} scenes while preserving my intent.`,
      ),
    onSuccess: (result) => {
      setUndoForm(form);
      if (result.project) {
        setForm((current) => mergeServerForm(current, result.project!.form));
      }
      setEnhancementProgress("Director update applied.");
    },
    onSettled: () => setEnhancementProgress(""),
  });
  const directorRepair = useMutation({
    mutationFn: (action: DirectorRepairAction) =>
      runDirectorProposal(action.message, action.selectedSceneId),
    onSuccess: (result) => {
      setUndoForm(form);
      if (result.project) {
        setForm((current) => mergeServerForm(current, result.project!.form));
      }
      setEnhancementProgress("Director repair applied. Review the updated direction, then retry.");
    },
    onSettled: () => setEnhancementProgress(""),
  });
  useEffect(() => {
    if (!sessionReady || !projectId || resumedDirectorJobRef.current === projectId) return;
    resumedDirectorJobRef.current = projectId;
    let cancelled = false;
    setEnhancementProgress("Checking for an unfinished Director request…");
    void resumePendingDirectorProposal(projectId, {
      onProgress: (job) => {
        if (!cancelled) setEnhancementProgress(storyboardAsyncProgressMessage(job));
      },
    })
      .then(async (proposal) => {
        if (cancelled) return;
        if (!proposal) {
          setEnhancementProgress("");
          return;
        }
        const result = await acceptDirectorProposal(proposal.id);
        if (cancelled) return;
        setUndoForm(form);
        if (result.project) {
          setForm((current) => mergeServerForm(current, result.project!.form));
        }
        setEnhancementProgress("Director update applied.");
      })
      .catch((error) => {
        if (!cancelled) {
          setEnhancementProgress(error instanceof Error ? error.message : "The Director request could not be resumed.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [form, projectId, sessionReady]);
  useEffect(() => {
    const items = gallery.data?.items ?? [];
    setHistory(items.slice(0, 8));
    if (!autoSelectedRef.current) return;
    const acceptedVideoIds = new Set(
      form.scenes
        .map((scene) => scene.acceptedVideoGenerationId)
        .filter((id): id is string => Boolean(id)),
    );
    const acceptedVideo = items.find(
      (item) =>
        acceptedVideoIds.has(item.id) &&
        item.status === "completed" &&
        item.output?.kind === "video",
    );
    const activeGeneration = items.find(
      (item) => !["completed", "failed", "cancelled"].includes(item.status),
    );
    const latestCompletedVideo = items.find(
      (item) =>
        item.status === "completed" && item.output?.kind === "video",
    );
    const candidate = acceptedVideo ?? activeGeneration ?? latestCompletedVideo;
    setSelected((current) =>
      current && current.id === candidate?.id ? current : candidate,
    );
  }, [form.scenes, gallery.data]);
  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        const owner = isProductionFirebase ? (await getFirebaseUser()).uid : "demo-user";
        const listed = await listStoryboardProjects();
        let available = listed.items;
        if (!available.length) {
          const legacy = await getStoryboardDraft().catch(() => ({
            form: null,
            updatedAt: null,
          }));
          const created = await createStoryboardProject(
            "Untitled film",
            (legacy.form ?? freshInitialForm()) as Record<string, unknown>,
          );
          available = [created];
        }
        const activeProject = available[0];
        const saved = await loadStoryboardSession(owner, activeProject.id);
        if (!active) return;
        setSessionOwner(owner);
        setProjects(available);
        setProjectId(activeProject.id);
        setProjectTitle(activeProject.title);
        if (saved) {
          const normalized = formForStudioVariant(saved, isClassic);
          setForm(await hydrateGeneratedFrameFiles(normalized));
        } else {
          setForm(factoryFormForStudioVariant(isClassic));
        }
        setSessionReady(true);
        setSessionStatus("saved");
      } catch {
        if (!active) return;
        setSessionReady(true);
        setSessionStatus("error");
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, [isClassic]);
  useEffect(() => {
    if (!sessionReady || !sessionOwner || !projectId) return;
    setSessionStatus("saving");
    const timer = window.setTimeout(() => {
      void saveStoryboardSession(sessionOwner, projectId, projectTitle, form)
        .then(() => {
          setSessionStatus("saved");
          setProjects((items) =>
            items
              .map((project) =>
                project.id === projectId
                  ? {
                      ...project,
                      title: projectTitle,
                      sceneCount: form.scenes.length,
                      updatedAt: new Date().toISOString(),
                    }
                  : project,
              )
              .sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
              ),
          );
        })
        .catch(() => setSessionStatus("error"));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [form, projectId, projectTitle, sessionOwner, sessionReady]);
  const generation = useQuery({
    queryKey: ["generation", selected?.id],
    queryFn: () => getGeneration(selected!.id),
    enabled: Boolean(selected?.id),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const current = query.state.data as Generation | undefined;
      return current &&
        ["completed", "failed", "cancelled"].includes(current.status)
        ? false
        : 2000;
    },
  });
  useEffect(() => {
    if (!generation.data) return;
    setSelected((current) =>
      current?.id === generation.data?.id ? generation.data : current,
    );
  }, [generation.data]);
  useEffect(() => {
    if (generation.data?.status !== "completed") return;
    if (generation.data.id === preservedGeneration?.id) return;
    setPreservedGeneration(undefined);
  }, [generation.data, preservedGeneration?.id]);
  useEffect(() => {
    setPreservedGeneration(undefined);
  }, [projectId]);
  useEffect(() => {
    if (!selected || ["completed", "failed", "cancelled"].includes(selected.status)) return;
    const errorMessage = generation.error instanceof Error ? generation.error.message : "";
    const pollingAuthFailed = /unauthori[sz]ed|forbidden|401|403/i.test(errorMessage);
    const updatedAt = Date.parse(selected.updatedAt);
    const stale = Number.isFinite(updatedAt) && Date.now() - updatedAt > 20 * 60_000;
    if (!pollingAuthFailed && !stale) return;
    setSelected({
      ...selected,
      status: "failed",
      safeErrorMessage: pollingAuthFailed
        ? "Render status could not be refreshed through the authenticated backend. Retry the render from the current project."
        : "This render did not report progress for too long and was cleared from the active preview. Retry the render from the current project.",
      updatedAt: new Date().toISOString(),
    });
  }, [generation.error, selected]);
  const currentGeneration = generation.data ?? selected;
  const isRendering =
    mutation.isPending ||
    assembly.isPending ||
    Boolean(
      currentGeneration &&
      !["completed", "failed", "cancelled"].includes(currentGeneration.status),
    );
  const cancellation = useMutation({
    mutationFn: () => cancelGeneration(currentGeneration!.id),
    onSuccess: (cancelled) => {
      pinSelected(cancelled);
      setHistory((items) =>
        items.map((item) => (item.id === cancelled.id ? cancelled : item)),
      );
      void queryClient.invalidateQueries({ queryKey: ["gallery"] });
      void queryClient.invalidateQueries({
        queryKey: ["generation", cancelled.id],
      });
    },
  });
  const openProject = async (nextProjectId: string) => {
    if (!sessionOwner || nextProjectId === projectId) return;
    const summary = projects.find((project) => project.id === nextProjectId);
    if (!summary) return;
    setProjectBusy(true);
    setProjectError("");
    setSessionReady(false);
    setSessionStatus("loading");
    try {
      const saved = await loadStoryboardSession(sessionOwner, nextProjectId);
      const normalized = saved
        ? formForStudioVariant(saved, isClassic)
        : factoryFormForStudioVariant(isClassic);
      setForm(await hydrateGeneratedFrameFiles(normalized));
      setProjectId(nextProjectId);
      setProjectTitle(summary.title);
      setUndoForm(undefined);
      setFrameStates({});
      setSceneRenderStates({});
      setSessionReady(true);
      setSessionStatus("saved");
    } catch (error) {
      setProjectError(
        error instanceof Error ? error.message : "Project could not be opened.",
      );
      setSessionReady(true);
      setSessionStatus("error");
    } finally {
      setProjectBusy(false);
    }
  };
  const createProject = async () => {
    setProjectBusy(true);
    setProjectError("");
    const nextForm = factoryFormForStudioVariant(isClassic);
    try {
      const title = `Untitled film ${projects.length + 1}`;
      const created = await createStoryboardProject(
        title,
        nextForm as unknown as Record<string, unknown>,
      );
      setProjects((items) => [created, ...items]);
      setProjectId(created.id);
      setProjectTitle(created.title);
      setForm(nextForm);
      setUndoForm(undefined);
      setFrameStates({});
      setSceneRenderStates({});
      setSessionReady(true);
      setSessionStatus("saved");
    } catch (error) {
      setProjectError(
        error instanceof Error
          ? error.message
          : "Project could not be created.",
      );
    } finally {
      setProjectBusy(false);
    }
  };
  const removeProject = async () => {
    if (!projectId || projects.length <= 1) return;
    if (
      !window.confirm(
        `Delete “${projectTitle}” and schedule its assets for removal?`,
      )
    )
      return;
    setProjectBusy(true);
    setProjectError("");
    try {
      await deleteStoryboardProject(projectId);
      await deleteStoryboardSession(sessionOwner, projectId).catch(
        () => undefined,
      );
      const remaining = projects.filter((project) => project.id !== projectId);
      setProjects(remaining);
      setProjectId("");
      await openProject(remaining[0].id);
    } catch (error) {
      setProjectError(
        error instanceof Error
          ? error.message
          : "Project could not be deleted.",
      );
    } finally {
      setProjectBusy(false);
    }
  };
  const totalSeconds = useMemo(
    () => form.scenes.reduce((sum, scene) => sum + scene.duration, 0),
    [form.scenes],
  );
  const updateScene = (index: number, patch: Partial<StoryboardScenePayload>) =>
    setForm((current) => ({
      ...current,
      scenes: current.scenes.map((scene, i) =>
        i === index ? { ...scene, ...patch } : scene,
      ),
    }));
  const regenerateFrame = async (index: number, edge: "start" | "end") => {
    const scene = form.scenes[index];
    const renderScene =
      isClassic && index === 0
        ? { ...scene, prompt: form.overallGoal.trim() }
        : scene;
    const stateKey = `${scene.id}:${edge}`;
    setFrameStates((current) => ({
      ...current,
      [stateKey]: { status: "queued" },
    }));
    try {
      if (!projectId)
        throw new Error("Choose a project before generating frames.");
      const submitted = await generateStoryboardFrame(
        form,
        renderScene,
        edge,
        projectId,
      );
      setFrameStates((current) => ({
        ...current,
        [stateKey]: { status: "generating" },
      }));
      const completed = await waitForGeneration(submitted.id);
      if (completed.status !== "completed" || !completed.output?.downloadUrl) {
        throw new Error(
          completed.safeErrorMessage || `The ${edge} frame was not generated.`,
        );
      }
      const blob = await fetchGenerationOutput(completed.output.downloadUrl);
      if (!blob.type.startsWith("image/"))
        throw new Error("The runtime returned an invalid frame artifact.");
      const extension =
        blob.type === "image/jpeg"
          ? "jpg"
          : blob.type === "image/webp"
            ? "webp"
            : "png";
      const file = new File([blob], `${scene.id}-${edge}-frame.${extension}`, {
        type: blob.type,
      });
      updateScene(index, {
        [edge === "start" ? "startFrame" : "endFrame"]: file,
        [edge === "start" ? "startFrameGenerationId" : "endFrameGenerationId"]:
          completed.id,
        staleReason:
          "A frame anchor changed after the previous storyboard render. Generate the film again to use it.",
      });
      setFrameStates((current) => ({
        ...current,
        [stateKey]: { status: "idle" },
      }));
    } catch (error) {
      setFrameStates((current) => ({
        ...current,
        [stateKey]: {
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : `The ${edge} frame could not be generated.`,
        },
      }));
    }
  };
  const generateMissingCreatorPreviews = async () => {
    setPreviewBatchBusy(true);
    try {
      for (let index = 0; index < form.scenes.length; index += 1) {
        const scene = form.scenes[index];
        if (!scene.startFrame && !scene.startFrameGenerationId) {
          await regenerateFrame(index, "start");
        }
        if (!scene.endFrame && !scene.endFrameGenerationId) {
          await regenerateFrame(index, "end");
        }
      }
    } finally {
      setPreviewBatchBusy(false);
    }
  };
  const renderScene = async (index: number) => {
    const scene = form.scenes[index];
    if (!projectId) return;
    setSceneRenderStates((current) => ({
      ...current,
      [scene.id]: { status: "queued" },
    }));
    try {
      const successfulIds = [...(scene.candidateGenerationIds ?? [])].slice(
        -24,
      );
      const variations = scene.candidateVariations ?? [];
      for (
        let candidateIndex = 0;
        candidateIndex < form.candidateCount;
        candidateIndex += 1
      ) {
        const variation = variations[candidateIndex];
        const candidateScene = variation
          ? {
              ...scene,
              prompt: `${scene.prompt}\n\nControlled draft variation: ${variation}`,
            }
          : scene;
        const submitted = await generateStoryboardScene(
          form,
          candidateScene,
          projectId,
        );
        pinSelected(submitted);
        setHistory((items) => [submitted, ...items].slice(0, 12));
        setSceneRenderStates((current) => ({
          ...current,
          [scene.id]: { status: "generating" },
        }));
        const completed = await waitForGeneration(submitted.id);
        if (
          completed.status !== "completed" ||
          completed.output?.kind !== "video"
        ) {
          throw new Error(
            completed.safeErrorMessage ||
              `Draft ${candidateIndex + 1} was not generated.`,
          );
        }
        successfulIds.push(completed.id);
        setForm((current) => ({
          ...current,
          scenes: current.scenes.map((candidate, sceneIndex) =>
            sceneIndex === index
              ? {
                  ...candidate,
                  candidateGenerationIds: [...successfulIds].slice(-24),
                }
              : candidate,
          ),
        }));
        pinSelected(completed);
        setHistory((items) =>
          items.map((item) => (item.id === completed.id ? completed : item)),
        );
      }
      setSceneRenderStates((current) => ({
        ...current,
        [scene.id]: { status: "idle" },
      }));
    } catch (error) {
      setSceneRenderStates((current) => ({
        ...current,
        [scene.id]: {
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "The scene clip could not be generated.",
        },
      }));
    }
  };
  const acceptSceneCandidate = (index: number, generationId: string) => {
    updateScene(index, {
      acceptedVideoGenerationId: generationId,
      staleReason: undefined,
    });
  };
  const moveScene = (index: number, direction: -1 | 1) =>
    setForm((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.scenes.length) return current;
      const scenes = [...current.scenes];
      [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
      return { ...current, scenes };
    });
  const addScene = () =>
    setForm((current) =>
      current.scenes.length >= MAX_STORYBOARD_SCENES
        ? current
        : {
            ...current,
            scenes: [
              ...current.scenes,
              {
                id: crypto.randomUUID(),
                title: `Scene ${current.scenes.length + 1}`,
                prompt: "",
                duration: 5,
                trimStart: 0,
                trimEnd: 5,
                seed: current.globalSeed + current.scenes.length,
                seedOverrideEnabled: false,
                summary: "",
                continuityOverrides: {},
                transition: "crossfade",
                transitionDuration: 0.75,
                carryPreviousFrame: true,
              },
            ],
          },
    );
  const removeScene = (index: number) =>
    setForm((current) =>
      current.scenes.length <= 1
        ? current
        : { ...current, scenes: current.scenes.filter((_, i) => i !== index) },
    );
  const hasRenderablePrompt = Boolean(form.overallGoal.trim());
  const invalid = !hasRenderablePrompt || !form.scenes.length;
  const runtimeMaxScenes = Math.min(
    MAX_STORYBOARD_SCENES,
    runtime.data?.capabilities?.maxScenes ?? MAX_STORYBOARD_SCENES,
  );
  const creatorMaxScenes = Math.min(MAX_CREATOR_SCENES, runtimeMaxScenes);
  const creatorPreviewReady = form.scenes.every(
    (scene) =>
      Boolean(scene.acceptedVideoGenerationId || scene.candidateGenerationIds?.length) ||
      (Boolean(scene.startFrame || scene.startFrameGenerationId) &&
        Boolean(scene.endFrame || scene.endFrameGenerationId)),
  );
  const canGenerateNow =
    sessionReady &&
    Boolean(projectId) &&
    !invalid &&
    !mutation.isPending &&
    !enhancement.isPending &&
    !classicBriefEnhancement.isPending &&
    !directorRepair.isPending;
  const runtimeFeatureStatus = runtime.data?.capabilities?.featureStatus ?? {};
  const runtimePostProcess = runtime.data?.capabilities?.postProcess;
  const upscaleSupported = postProcessSupportsUpscale(runtimePostProcess);
  const upscaleEnabled = postProcessUpscaleEnabled(form.postProcess);
  const videoModels = longFormVideoModelsForRuntime(runtime.data);
  const runtimeDefaultVideoModel = defaultLongFormVideoModelForRuntime(runtime.data);
  const selectedVideoModel = form.videoModel ?? runtimeDefaultVideoModel;
  useEffect(() => {
    if (!runtime.data?.capabilities?.videoModels?.length) return;
    const currentModel = form.videoModel ?? "ltx-2.3";
    if (longFormVideoModelAvailable(runtime.data, currentModel)) return;
    const nextModel = defaultLongFormVideoModelForRuntime(runtime.data);
    if (currentModel === nextModel) return;
    setForm((current) => prepareLongFormVideoModelSwitch(current, nextModel));
  }, [form.videoModel, runtime.data]);
  const changeVideoModel = async (videoModel: LongFormVideoModel) => {
    if (selectedVideoModel === videoModel) return;
    const copy = prepareLongFormVideoModelSwitch(form, videoModel);
    const hasRenderedVideo = longFormProjectHasRenderedVideo(form);
    if (!hasRenderedVideo) {
      setForm(copy);
      return;
    }
    if (!globalThis.confirm(
      "This project already has generated video drafts. Create a separate copy for the selected model so the original stays unchanged?",
    )) return;
    setProjectBusy(true);
    setProjectError("");
    try {
      const label = videoModel === "ltx-2.5" ? "LTX 2.5 Preview" : "LTX 2.3";
      const title = `${projectTitle} - ${label}`.slice(0, 160);
      const serializable = JSON.parse(JSON.stringify(copy, (_key, value) =>
        value instanceof File ? undefined : value,
      )) as Record<string, unknown>;
      const created = await createStoryboardProject(title, serializable);
      if (sessionOwner) await saveStoryboardSession(sessionOwner, created.id, title, copy);
      setProjects((items) => [created, ...items]);
      setProjectId(created.id);
      setProjectTitle(title);
      setForm(copy);
      setUndoForm(undefined);
      setFrameStates({});
      setSceneRenderStates({});
      setSessionStatus("saved");
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "The model-specific project copy could not be created.");
    } finally {
      setProjectBusy(false);
    }
  };
  const resetProjectToFactory = async () => {
    if (!window.confirm("Reset this project to factory settings? This clears prompts, hidden Director context, frame anchors, references, settings and selected renders from the current project.")) {
      return;
    }
    const nextForm = factoryFormForStudioVariant(isClassic);
    setForm(nextForm);
    setUndoForm(undefined);
    setEnhancementProgress("");
    setFrameStates({});
    setSceneRenderStates({});
    setPreviewBatchBusy(false);
    setSelected(undefined);
    setPreservedGeneration(undefined);
    autoSelectedRef.current = false;
    setProjectError("");
    if (projectId) clearPendingStoryboardProjectJobs(projectId);
    if (!sessionOwner || !projectId) return;
    setSessionStatus("saving");
    try {
      await saveStoryboardSession(sessionOwner, projectId, projectTitle, nextForm);
      setSessionStatus("saved");
      setProjects((items) =>
        items.map((project) =>
          project.id === projectId
            ? {
                ...project,
                sceneCount: nextForm.scenes.length,
                updatedAt: new Date().toISOString(),
              }
            : project,
        ),
      );
    } catch {
      setSessionStatus("error");
    }
  };
  const allScenesAccepted =
    form.scenes.length > 0 &&
    form.scenes.every(
      (scene) => scene.acceptedVideoGenerationId && !scene.staleReason,
    );
  const runtimeConnected = runtime.data?.status === "healthy";
  const sessionControls = (
    <div className="lf-session">
      <button
        type="button"
        className={`lf-status-toggle ${
          runtime.isLoading
            ? "lf-status-pending"
            : runtimeConnected
              ? "lf-status-ok"
              : "lf-status-down"
        }`}
        disabled={runtime.isLoading || runtimeConnected}
        onClick={() => void runtime.refetch()}
        data-help={
          runtimeConnected
            ? "Shows whether the remote video-generation runtime is available."
            : "The runtime could not be reached. Select to retry the connection."
        }
      >
        {runtime.isLoading
          ? "Checking generator"
          : runtimeConnected
            ? "Generator connected"
            : "Try again"}
      </button>
      <button
        type="button"
        className="lf-help-toggle"
        aria-pressed={helpMode}
        onClick={() => setHelpMode((enabled) => !enabled)}
        data-help="Turn contextual explanations off."
      >
        {helpMode ? "✦ Help on" : "? Help"}
      </button>
      <button
        type="button"
        className="lf-reset-button"
        disabled={!sessionReady || isRendering}
        onClick={() => void resetProjectToFactory()}
        data-help="Reset every visible and hidden storyboard field to the factory defaults."
      >
        Reset
      </button>
      {sessionStatus === "error" && (
        <span
          className="lf-session-save error"
          data-help="Your brief, prompts, titles, settings and uploaded frame images could not be saved in this browser."
        >
          Session save unavailable
        </span>
      )}
    </div>
  );

  const generateVideoAction = isClassic ? (
    <div className="lf-preview-actions lf-generate-inline">
      <button
        type="button"
        data-help="Send this Director-ready idea and the three chosen video settings to the private generation queue."
        disabled={!canGenerateNow}
        className="lf-primary lf-generate"
        onClick={() => mutation.mutate()}
      >
        <span className="lf-button-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M8 5.8v12.4c0 .8.9 1.3 1.6.9l9.2-6.2a1.1 1.1 0 0 0 0-1.8L9.6 4.9C8.9 4.5 8 5 8 5.8Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span>
          {mutation.isPending ? "◌ Generating video…" : "Generate video"}
        </span>
      </button>
    </div>
  ) : undefined;

  const videoSettingsPanel = isClassic ? (
    <details className="lf-frame-details lf-settings-drawer">
    <summary>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 15z" />
      </svg>
      Settings
    </summary>
    <div className="lf-video-settings-panel">
    <div className="lf-video-settings">
      <div className="lf-video-settings-row">
        <IconField icon="▦" label="Resolution">
          <select
            aria-label="Resolution"
            disabled={!sessionReady}
            value={form.resolution}
            onChange={(event) =>
              setForm((current) =>
                markAcceptedClipsStale(
                  { ...current, resolution: event.target.value },
                  "The resolution changed after this clip was accepted. Generate it again at the new size.",
                ),
              )
            }
          >
            {minimalResolutionOptions[
              minimalAspectRatio(form.resolution)
            ].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </IconField>
        <IconField icon="▭" label="Aspect ratio">
          <select
            aria-label="Aspect ratio"
            disabled={!sessionReady}
            value={minimalAspectRatio(form.resolution)}
            onChange={(event) =>
              setForm((current) =>
                markAcceptedClipsStale(
                  {
                    ...current,
                    resolution: resolutionForAspectRatio(
                      event.target.value as MinimalAspectRatio,
                      current.resolution,
                    ),
                  },
                  "The aspect ratio changed after this clip was accepted. Generate it again to use the new framing.",
                ),
              )
            }
          >
            <option value="16:9">Landscape · 16:9</option>
            <option value="9:16">Portrait · 9:16</option>
            <option value="1:1">Square · 1:1</option>
          </select>
        </IconField>
        <IconField icon="♪" label="Sound behaviour">
          <div className="lf-inline-director-control">
            <select
              aria-label="Sound behaviour"
              disabled={!sessionReady}
              value={form.audioPolicy.mode}
              onChange={(event) => {
                const mode = event.target.value as LongFormGenerationPayload["audioPolicy"]["mode"];
                setForm((current) =>
                  markAcceptedClipsStale(
                    {
                      ...current,
                      audioPolicy: {
                        ...current.audioPolicy,
                        mode,
                        dialogue: mode === "silent" ? "off" : current.audioPolicy.dialogue,
                        soundEffects: mode === "silent" ? "off" : current.audioPolicy.soundEffects,
                        ambience: mode === "silent" ? "off" : current.audioPolicy.ambience,
                        music: mode === "silent" ? "off" : current.audioPolicy.music,
                        preserveSourceAudio: mode !== "silent" && current.audioPolicy.preserveSourceAudio,
                      },
                    },
                    "The sound policy changed after this clip was accepted. Generate it again to use the new sound behaviour.",
                  ),
                );
              }}
            >
              <option value="silent">Silent</option>
              <option value="intent_only">Only when requested</option>
              <option value="directed">Directed sound</option>
            </select>
            <button
              type="button"
              className="lf-icon-director"
              disabled={!sessionReady || directorRepair.isPending}
              onClick={() =>
                directorRepair.mutate({
                  message: directorProjectSoundMessage(form.audioPolicy.mode),
                })
              }
            >
              Director
            </button>
          </div>
        </IconField>
      </div>
    </div>
    <div className="lf-preview-formats">
      <div className="lf-preview-formats-row">
      <div className="lf-format-presets">
        {formatPresets.map((preset) => {
          const active = form.resolution === preset.resolution;
          return (
            <button
              key={preset.key}
              type="button"
              aria-pressed={active}
              disabled={!sessionReady}
              className={`lf-format-preset ${active ? "active" : ""}`}
              onClick={() =>
                setForm((current) =>
                  markAcceptedClipsStale(
                    {
                      ...current,
                      resolution: preset.resolution,
                      fps: preset.fps,
                    },
                    "The output format changed after this clip was accepted. Render this scene again before assembly.",
                  ),
                )
              }
            >
              <SocialIcon platform={preset.platform} />
              <span>
                <strong>{preset.label}</strong>
                <small>{preset.sublabel}</small>
              </span>
            </button>
          );
        })}
      </div>
      {form.scenes[0] && (
        <div className="lf-minimal-duration">
          <span className="lf-label lf-format-heading">
            Length
            <output className="lf-duration-value">
              {Math.min(totalSeconds, creatorMaxScenes * 8)}
              <small>s</small>
            </output>
          </span>
          <input
            type="range"
            className="lf-minimal-duration-slider"
            aria-label="Video length"
            disabled={!sessionReady}
            min={1}
            max={creatorMaxScenes * 8}
            step={1}
            value={Math.min(totalSeconds, creatorMaxScenes * 8)}
            onChange={(event) => {
              const value = Number(event.target.value);
              setForm((current) => ({
                ...current,
                scenes: creatorScenesForTotalDuration(
                  current.scenes,
                  value,
                  current.globalSeed,
                  creatorMaxScenes,
                ),
              }));
            }}
          />
        </div>
      )}
      </div>
    </div>
    </div>
    </details>
  ) : undefined;

  return (
    <main className={`lf-page ${helpMode ? "help-mode" : ""}`}>
      {!isClassic && (
        <header className="lf-hero">
          <div>
            <h1 className="editorial-page-title lf-storyboard-title">
              Storyboard Studio
              <span className="editorial-title-stop">.</span>
            </h1>
            <p>
              Direct a longer film scene by scene. Upload frame anchors where they
              matter; otherwise the runtime generates the opening and carries each
              real final frame into the next clip.
            </p>
          </div>
          {sessionControls}
        </header>
      )}
      <div className={`lf-layout ${isClassic ? "lf-layout-minimal" : ""}`}>
        <div className="lf-controls">
          {!isClassic && (
          <section
            className={`lf-panel lf-goal ${isClassic ? "lf-minimal-director" : ""}`}
          >
            <span className="lf-label">
              {isClassic ? "Director" : "Creative brief"}
            </span>
            <div className="prompt-field-heading">
              <h2>{isClassic ? "Create your storyboard" : "Overview"}</h2>
              {!isClassic && (
                <button
                  type="button"
                  className="lf-outline lf-polish-brief"
                  disabled={
                    !sessionReady ||
                    !form.overallGoal.trim() ||
                    enhancement.isPending ||
                    classicBriefEnhancement.isPending
                  }
                  onClick={() => enhancement.mutate({ apply: "master" })}
                >
                  {enhancement.isPending ? "Director is working…" : "Polish brief"}
                </button>
              )}
            </div>
            <div
              className="lf-help-target"
              data-help="The master brief for the entire film: story progression, recurring characters, locations, palette, lens language and continuity rules."
            >
              <textarea
                aria-label="Overall artistic goal"
                value={form.overallGoal}
                disabled={!sessionReady}
                placeholder={
                  isClassic
                    ? "What should happen in your video? Write it in your own words…"
                    : "Describe the story, subject, visual language and continuity for the whole film…"
                }
                onChange={(event) =>
                  setForm((current) =>
                    markAcceptedClipsStale(
                      { ...current, overallGoal: event.target.value },
                      "The film brief changed after this clip was accepted. Render this scene again before assembly.",
                    ),
                  )
                }
              />
            </div>
            <p>
              {isClassic
                ? "Use everyday language. The Director can turn your idea into production-ready cinematic direction before you generate."
                : "Set the visual and narrative rules for the whole film. Each scene then contributes one clear action and camera beat."}
            </p>
            {isClassic && !sessionReady && (
              <p className="lf-minimal-session-state" role="status">
                Opening your private project…
              </p>
            )}
            {enhancementProgress && (
              <p className="lf-minimal-session-state" role="status" aria-live="polite">
                {enhancementProgress}
              </p>
            )}
            {(form.originalOverallGoal || undoForm) && (
              <div
                className="lf-enhancer-actions"
                aria-label="Local Gemma prompt assistance"
              >
                {form.originalOverallGoal && (
                  <button
                    type="button"
                    onClick={() =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          {
                            ...current,
                            overallGoal:
                              current.originalOverallGoal ?? current.overallGoal,
                          },
                          "The film brief changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  >
                    Restore original brief
                  </button>
                )}
                {undoForm && (
                  <button
                    type="button"
                    onClick={() => {
                      setForm(undoForm);
                      setUndoForm(undefined);
                    }}
                  >
                    Undo enhancement
                  </button>
                )}
              </div>
            )}
            {enhancement.error && (
              <p className="lf-error" role="alert">
                {enhancement.error.message}
              </p>
            )}
            {classicBriefEnhancement.error && (
              <p className="lf-error" role="alert">
                {classicBriefEnhancement.error.message}
              </p>
            )}
            {directorRepair.error && (
              <p className="lf-error" role="alert">
                {directorRepair.error.message}
              </p>
            )}
            {isClassic && (
              <div className="lf-polish-brief-footer">
                <button
                  type="button"
                  className="lf-outline lf-polish-brief"
                  disabled={
                    !sessionReady ||
                    !form.overallGoal.trim() ||
                    classicBriefEnhancement.isPending
                  }
                  onClick={() => classicBriefEnhancement.mutate()}
                >
                  {classicBriefEnhancement.isPending
                    ? "Director is working…"
                    : "Improve with Director"}
                </button>
              </div>
            )}
          </section>
          )}
          <>
              {!isClassic && <ProjectReferencePanel
                references={form.projectReferences}
                sceneIds={form.scenes.map((scene) => scene.id)}
                evidence={form.referencePlanningEvidence}
                onChange={(projectReferences) =>
                  setForm((current) => ({ ...current, projectReferences }))
                }
                globalSeed={form.globalSeed}
                seedPolicy={form.seedPolicy}
                onSeedPolicyChange={(seedPolicy) =>
                  setForm((current) =>
                    markAcceptedClipsStale(
                      { ...current, seedPolicy },
                      "The visual seed policy changed after this clip was accepted. Render this scene again before assembly.",
                    ),
                  )
                }
                onGlobalSeedChange={(globalSeed) =>
                  setForm((current) =>
                    markAcceptedClipsStale(
                      { ...current, globalSeed },
                      "The global visual seed changed after this clip was accepted. Render this scene again before assembly.",
                    ),
                  )
                }
                referenceConditioningSupported={
                  runtime.data?.capabilities?.referenceConditioning === true &&
                  runtime.data?.capabilities?.featureStatus?.referenceConditioning === "supported"
                }
                onToggleSceneReference={(sceneId, referenceId, attached) => {
                  const index = form.scenes.findIndex((scene) => scene.id === sceneId);
                  if (index === -1) return;
                  const scene = form.scenes[index];
                  const current = scene.referenceIds ?? [];
                  updateScene(index, {
                    referenceIds: attached
                      ? [...current, referenceId]
                      : current.filter((id) => id !== referenceId),
                  });
                }}
              />}
              <section
                className={`lf-scenes ${isClassic ? "lf-panel lf-scenes-panel" : ""}`}
              >
                <div className="lf-section-head">
                  <div>
                    {isClassic ? (
                      <div className="lf-section-brand">
                        <span className="lf-section-brand-mark">
                          <img src="/fav-icon.png" alt="" />
                        </span>
                        <span className="site-page-title">VideoLab.creator</span>
                      </div>
                    ) : (
                      <h2>Storyboard scenes</h2>
                    )}
                  </div>
                  {!isClassic && (
                    <button
                      type="button"
                      className="lf-primary lf-add"
                      data-help="Append a new editable scene card up to the active LongForm runtime limit."
                      disabled={form.scenes.length >= runtimeMaxScenes}
                      onClick={addScene}
                    >
                      ＋ Add scene
                    </button>
                  )}
                </div>
                {form.scenes.map((scene, index) => (
                  <SceneCard
                    key={scene.id}
                    scene={scene}
                    creatorPrompt={isClassic && index === 0 ? form.overallGoal : undefined}
                    index={index}
                    count={form.scenes.length}
                    previewGate={
                      isClassic && index === 0 && !creatorPreviewReady ? (
                        <button
                          type="button"
                          className="lf-outline lf-generate-frames"
                          disabled={!sessionReady || previewBatchBusy || enhancement.isPending || classicBriefEnhancement.isPending || directorRepair.isPending}
                          onClick={() => void generateMissingCreatorPreviews()}
                        >
                          {previewBatchBusy ? "Generating…" : "Generate first/last"}
                        </button>
                      ) : undefined
                    }
                    generateAction={
                      isClassic && index === 0 ? generateVideoAction : undefined
                    }
                    onChange={(patch) => updateScene(index, patch)}
                    onCreatorPromptChange={
                      isClassic && index === 0
                        ? (overallGoal) =>
                            setForm((current) =>
                              markAcceptedClipsStale(
                                {
                                  ...current,
                                  overallGoal,
                                  scenes: current.scenes.map((candidate, sceneIndex) =>
                                    sceneIndex === 0
                                      ? {
                                          ...candidate,
                                          prompt: "",
                                          promptOrigin: "user",
                                          staleReason:
                                            candidate.startFrame ||
                                            candidate.endFrame ||
                                            candidate.acceptedVideoGenerationId
                                              ? "This direction changed after its frame anchors were created. Review or regenerate them before rendering."
                                              : candidate.staleReason,
                                        }
                                      : candidate,
                                  ),
                                },
                                "The creator prompt changed after this clip was accepted. Generate the film again to use it.",
                              ),
                            )
                        : undefined
                    }
                    onMove={(direction) => moveScene(index, direction)}
                    onRemove={() => removeScene(index)}
                    frameState={{
                      start: frameStates[`${scene.id}:start`] ?? {
                        status: "idle",
                      },
                      end: frameStates[`${scene.id}:end`] ?? { status: "idle" },
                    }}
                    onGenerateFrame={(edge) =>
                      void regenerateFrame(index, edge)
                    }
                    onRegeneratePrompt={
                      isClassic
                        ? () => classicBriefEnhancement.mutate()
                        : () =>
                            enhancement.mutate({
                              apply: "shot",
                              targetShotNumber: index + 1,
                            })
                    }
                    promptBusy={
                      !sessionReady ||
                      enhancement.isPending ||
                      directorRepair.isPending ||
                      classicBriefEnhancement.isPending
                    }
                    renderState={
                      sceneRenderStates[scene.id] ?? { status: "idle" }
                    }
                    onRender={() => void renderScene(index)}
                    onAskDirectorRepair={(error) =>
                      directorRepair.mutate({
                        selectedSceneId: scene.id,
                        message: directorRepairMessage(error, "scene"),
                      })
                    }
                    onAskDirectorSound={() =>
                      directorRepair.mutate({
                        selectedSceneId: scene.id,
                        message: directorSceneSoundMessage(index + 1, scene),
                      })
                    }
                    onAcceptCandidate={(generationId) =>
                      acceptSceneCandidate(index, generationId)
                    }
                    globalSeed={form.globalSeed}
                    seedPolicy={form.seedPolicy}
                    classic={isClassic}
                    negativePrompt={form.negativePrompt}
                    stopGeneratedText={
                      form.generatedTextPolicy.mode === "forbidden"
                    }
                    onStopGeneratedTextChange={(enabled) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          {
                            ...current,
                            generatedTextPolicy:
                              generatedTextPolicyForNoText(enabled),
                          },
                          "The generated text policy changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                    onNegativePromptChange={(value) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          { ...current, negativePrompt: value },
                          "The shared negative prompt changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  />
                ))}
                {isClassic && enhancementProgress && (
                  <p
                    className="lf-minimal-session-state"
                    role="status"
                    aria-live="polite"
                  >
                    {enhancementProgress}
                  </p>
                )}
                {isClassic && classicBriefEnhancement.error && (
                  <p className="lf-error" role="alert">
                    {classicBriefEnhancement.error.message}
                  </p>
                )}
                {isClassic && enhancement.error && (
                  <p className="lf-error" role="alert">
                    {enhancement.error.message}
                  </p>
                )}
                {isClassic && directorRepair.error && (
                  <p className="lf-error" role="alert">
                    {directorRepair.error.message}
                  </p>
                )}
              </section>
          </>
        </div>
        <aside className="lf-preview-col">
          {!isClassic && (
            <section className="lf-panel lf-storyboard-settings">
              <span className="lf-label">Setup</span>
              <h2>Storyboard settings</h2>
              <div className="lf-settings">
                <Field
                  label="Video model"
                  help="Projects stay pinned to this model. Switching preserves existing media and marks accepted clips for regeneration."
                >
                  <select
                    aria-label="Video model"
                    value={selectedVideoModel}
                    onChange={(event) =>
                      void changeVideoModel(event.target.value as LongFormVideoModel)
                    }
                  >
                    {videoModels.map((model) => (
                      <option key={model.id} value={model.id} disabled={!model.available}>
                        {longFormVideoModelLabel(model)}
                      </option>
                    ))}
                  </select>
                  {videoModels.find((model) => model.id === selectedVideoModel)?.reason && (
                    <small>{videoModels.find((model) => model.id === selectedVideoModel)?.reason}</small>
                  )}
                  <small>Submitting {selectedVideoModel}</small>
                </Field>
                <Field
                  label="Sound behaviour"
                  help="Only when requested is conservative: mood words never add music, while quoted dialogue and explicit sound markers can enable sound."
                >
                  <div className="lf-inline-director-control">
                    <select
                      value={form.audioPolicy.mode}
                      onChange={(event) => {
                        const mode = event.target
                          .value as LongFormGenerationPayload["audioPolicy"]["mode"];
                        setForm((current) =>
                          markAcceptedClipsStale(
                            {
                              ...current,
                              audioPolicy: {
                                ...current.audioPolicy,
                                mode,
                                dialogue:
                                  mode === "silent"
                                    ? "off"
                                    : current.audioPolicy.dialogue,
                                soundEffects:
                                  mode === "silent"
                                    ? "off"
                                    : current.audioPolicy.soundEffects,
                                ambience:
                                  mode === "silent"
                                    ? "off"
                                    : current.audioPolicy.ambience,
                                music:
                                  mode === "silent"
                                    ? "off"
                                    : current.audioPolicy.music,
                                preserveSourceAudio:
                                  mode !== "silent" &&
                                  current.audioPolicy.preserveSourceAudio,
                              },
                            },
                            "The sound policy changed after this clip was accepted. Render it again before assembly.",
                          ),
                        );
                      }}
                    >
                      <option value="silent">Silent</option>
                      <option value="intent_only">Only when requested</option>
                      <option value="directed">Directed sound</option>
                    </select>
                    <button
                      type="button"
                      className="lf-icon-director"
                      disabled={!sessionReady || directorRepair.isPending}
                      onClick={() =>
                        directorRepair.mutate({
                          message: directorProjectSoundMessage(form.audioPolicy.mode),
                        })
                      }
                    >
                      Director
                    </button>
                  </div>
                </Field>
                <Field
                  label="On-screen text"
                  help="Visible generated text is disabled for the Creator launch workflow."
                >
                  <span className="lf-static-setting">Disabled</span>
                </Field>
                <NumberField
                  label="Drafts per scene"
                  help="Drafts run sequentially so one creator cannot monopolise the shared generation pool."
                  value={form.candidateCount}
                  min={1}
                  max={4}
                  step={1}
                  onChange={(candidateCount) =>
                    setForm((current) => ({
                      ...current,
                      candidateCount: Math.min(
                        4,
                        Math.max(1, Math.round(candidateCount)),
                      ),
                    }))
                  }
                />
                <Field
                  label="Working resolution"
                  help="Sets the frame dimensions. Draft sizes render faster; HD sizes contain more detail and require more processing."
                >
                  <select
                    value={form.resolution}
                    onChange={(event) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          { ...current, resolution: event.target.value },
                          "The output resolution changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  >
                    <option value="1024x576">Landscape Draft 1024x576</option>
                    <option value="1280x720">Landscape HD 1280x720</option>
                    <option value="576x1024">Phone Draft 576x1024</option>
                    <option value="720x1280">Phone HD 720x1280</option>
                    <option value="1080x1080">Square 1080x1080</option>
                  </select>
                </Field>
                <Field
                  label="Frame rate"
                  help="Frames shown per second. 24 fps feels cinematic; 25 fps suits PAL delivery; 30 fps feels slightly smoother."
                >
                  <select
                    value={form.fps}
                    onChange={(event) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          { ...current, fps: Number(event.target.value) },
                          "The frame rate changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  >
                    <option value={24}>24 fps</option>
                    <option value={25}>25 fps</option>
                    <option value={30}>30 fps</option>
                  </select>
                </Field>
                <Field
                  label="Visual seed policy"
                  help="A locked seed gives every scene the same identity anchor. Scene overrides allow deliberate variation without random drift."
                >
                  <select
                    value={form.seedPolicy}
                    onChange={(event) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          {
                            ...current,
                            seedPolicy: event.target.value as
                              "global_locked" | "scene_overrides",
                          },
                          "The visual seed policy changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  >
                    <option value="global_locked">
                      Lock one seed across the film
                    </option>
                    <option value="scene_overrides">
                      Allow deliberate scene overrides
                    </option>
                  </select>
                </Field>
                <NumberField
                  label="Global visual seed"
                  help="Keeps reproducible visual choices across the film. It does not replace prompt or frame continuity."
                  value={form.globalSeed}
                  min={0}
                  max={999999999}
                  step={1}
                  onChange={(globalSeed) =>
                    setForm((current) =>
                      markAcceptedClipsStale(
                        { ...current, globalSeed },
                        "The global visual seed changed after this clip was accepted. Render this scene again before assembly.",
                      ),
                    )
                  }
                />
              </div>
              {form.audioPolicy.mode === "directed" && (
                <details className="lf-continuity-details">
                  <summary>
                    Direct dialogue, ambience, effects and music
                  </summary>
                  <div className="lf-settings">
                    {(
                      [
                        [
                          "dialogue",
                          "Dialogue",
                          ["off", "prompted_only", "on"],
                        ],
                        [
                          "soundEffects",
                          "Sound effects",
                          ["off", "intent_only", "on"],
                        ],
                        ["ambience", "Ambience", ["off", "intent_only", "on"]],
                        [
                          "music",
                          "Music",
                          ["off", "prompted_or_unambiguous_performance", "on"],
                        ],
                      ] as const
                    ).map(([key, label, options]) => (
                      <Field key={key} label={label}>
                        <select
                          value={form.audioPolicy[key]}
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              audioPolicy: {
                                ...current.audioPolicy,
                                [key]: event.target.value,
                              },
                            }))
                          }
                        >
                          {options.map((option) => (
                            <option key={option} value={option}>
                              {option.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                    <label className="lf-toggle">
                      <input
                        type="checkbox"
                        checked={form.audioPolicy.preserveSourceAudio}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            audioPolicy: {
                              ...current.audioPolicy,
                              preserveSourceAudio: event.target.checked,
                            },
                          }))
                        }
                      />
                      <span /> Preserve supplied source audio
                    </label>
                  </div>
                </details>
              )}
              <p className="lf-capability-note">
                This generator supports up to {runtimeMaxScenes} scenes, 1–8
                seconds per scene, independent frame anchors, individual scene
                renders and final assembly that enforces your sound policy.
              </p>
              <div className="lf-plan">
                <button
                  type="button"
                  className="lf-outline"
                  data-help="Ask the local Gemma enhancer to create exactly one editable prompt for every existing scene card."
                  disabled={!form.overallGoal.trim() || enhancement.isPending}
                  onClick={() => enhancement.mutate({ apply: "all" })}
                >
                  ✣ Plan scenes
                </button>
                <div
                  className="lf-count"
                  data-help="Shows the number of planned scenes and their combined running time."
                >
                  <strong>
                    {form.scenes.length}/{runtimeMaxScenes}
                  </strong>{" "}
                  scenes
                  <br />
                  <strong>
                    {Math.floor(totalSeconds / 60)}:
                    {String(Math.round(totalSeconds % 60)).padStart(2, "0")}
                  </strong>{" "}
                  requested
                </div>
              </div>
            </section>
          )}
          {!isClassic && (
            <section
              className="lf-panel lf-assembly"
              aria-label="Accepted scene assembly"
            >
              <span className="lf-label">Finishing</span>
              <h2>Assemble accepted clips</h2>
              <p>
                Render and accept one clip per scene, then join only those
                clips. Assembly preserves the full accepted clips and
                transitions without rerunning LTX.
              </p>
              <strong>
                {
                  form.scenes.filter(
                    (scene) =>
                      scene.acceptedVideoGenerationId && !scene.staleReason,
                  ).length
                }
                /{form.scenes.length} clips ready
              </strong>
              <button
                type="button"
                className="lf-primary"
                disabled={
                  !allScenesAccepted || assembly.isPending || isRendering
                }
                onClick={() => assembly.mutate()}
              >
                {assembly.isPending ? "Assembling…" : "Assemble accepted clips"}
              </button>
              {assembly.error && (
                <p className="lf-error" role="alert">
                  {assembly.error.message}
                </p>
              )}
            </section>
          )}
          {!isClassic && (
            <section className="lf-panel lf-bible lf-storyboard-setup">
              <span className="lf-label">Film Bible</span>
              <h2>Continuity</h2>
              <p>Keep visual guidance together for the complete storyboard.</p>
              <details className="lf-continuity-details">
                <summary>Review and edit the continuity bible</summary>
                <div className="lf-continuity-grid">
                  {continuityFields.map(([key, label]) => (
                    <label key={key}>
                      <span>{label}</span>
                      <textarea
                        value={form.continuityBible[key]}
                        onChange={(event) =>
                          setForm((current) =>
                            markAcceptedClipsStale(
                              {
                                ...current,
                                continuityBible: {
                                  ...current.continuityBible,
                                  [key]: event.target.value,
                                },
                              },
                              "The continuity bible changed after this clip was accepted. Render this scene again before assembly.",
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              </details>
              <p className="lf-capability-note">
                Project references guide Gemma's continuity plan, but the active
                LongForm worker does not yet condition LTX directly on
                character, style or voice media. Per-scene first and last frames
                remain the verified visual controls.
              </p>
              <div className="lf-bible-grid">
                <UploadBox
                  label="Global visual anchor"
                  help="Optional fallback image for the opening visual when a scene has no dedicated start frame."
                  compact
                  file={form.globalVisualAnchor}
                  onFile={(file) =>
                    setForm((current) => ({
                      ...current,
                      globalVisualAnchor: file,
                    }))
                  }
                />
                <label
                  className="lf-toggle"
                  data-help="Allow the global visual anchor to be used when a scene does not supply its own start frame."
                >
                  <input
                    type="checkbox"
                    checked={form.globalVisualAnchorEnabled}
                    onChange={(event) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          {
                            ...current,
                            globalVisualAnchorEnabled: event.target.checked,
                          },
                          "The visual-anchor policy changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  />
                  <span /> Enable anchor fallback
                </label>
              </div>
            </section>
          )}
          {!isClassic && (
            <details className="lf-panel lf-production">
              <summary data-help="Open lower-level rendering controls. Defaults are tuned for reliable storyboard generation, so adjust these only when you need a specific render behavior.">
                <span>
                  <span className="lf-label">Advanced</span>
                  <h2>Production settings</h2>
                </span>
                <span className="lf-production-toggle" aria-hidden="true">
                  ＋
                </span>
              </summary>
              <div className="lf-production-content">
                <div className="lf-settings">
                  <Range
                    label="Opening frame steps"
                    help="How much generation work Z-Image spends resolving an opening frame. Higher values can add detail but take longer."
                    value={form.imageSteps}
                    min={1}
                    max={12}
                    step={1}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, imageSteps: value }))
                    }
                  />
                  <Range
                    label="LTX guidance"
                    help="How strongly LTX follows the written scene direction. Higher is more literal; lower allows more visual interpretation."
                    value={form.guidanceScale}
                    min={0}
                    max={8}
                    step={0.25}
                    onChange={(value) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          { ...current, guidanceScale: value },
                          "LTX guidance changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  />
                  <Range
                    label="Start frame strength"
                    help="How closely the beginning of each generated clip follows its supplied or inherited start frame."
                    value={form.startFrameStrength}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(value) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          { ...current, startFrameStrength: value },
                          "Start-frame strength changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  />
                  <Range
                    label="End frame strength"
                    help="How closely the final part of a clip aims toward a supplied end frame. Lower values permit freer motion."
                    value={form.endFrameStrength}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(value) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          { ...current, endFrameStrength: value },
                          "End-frame strength changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  />
                  <Field
                    label="Enhance scene prompts"
                    help="Lets the runtime enrich short scene directions with production detail before generating the clips."
                  >
                    <select
                      value={form.enhancePrompt ? "yes" : "no"}
                      onChange={(event) =>
                        setForm((current) =>
                          markAcceptedClipsStale(
                            {
                              ...current,
                              enhancePrompt: event.target.value === "yes",
                            },
                            "Runtime prompt enhancement changed after this clip was accepted. Render this scene again before assembly.",
                          ),
                        )
                      }
                    >
                      <option value="yes">Enabled</option>
                      <option value="no">Disabled</option>
                    </select>
                  </Field>
                  <div
                    className={`lf-field lf-upscale-controls ${!upscaleSupported ? "is-disabled" : ""}`}
                    data-help="LongForm runtime upscale is a delivery pass after generation. The current runtime documents a fixed 2x Lanczos upscale, capped at 3840 x 2160, with high-quality CRF 18 output."
                  >
                    <span className="lf-label">Upscale</span>
                    <label className="lf-toggle lf-ultra-toggle">
                      <input
                        type="checkbox"
                        checked={upscaleEnabled}
                        disabled={!upscaleSupported}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            postProcess: event.target.checked
                              ? current.postProcess === "interpolate"
                                ? "both"
                                : "upscale"
                              : current.postProcess === "both"
                                ? "interpolate"
                                : "none",
                          }))
                        }
                      />
                      <span aria-hidden="true" />
                      <span className="lf-toggle-copy">
                        <strong>{upscaleSupported ? "Delivery upscale" : "Upscale unavailable"}</strong>
                        <small>
                          {upscaleSupported
                            ? "Adds the runtime post-process upscale pass."
                            : "The connected runtime does not advertise upscale."}
                        </small>
                      </span>
                    </label>
                    <div className="lf-upscale-grid">
                      <label>
                        <span>Mode</span>
                        <select
                          value={form.postProcess}
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              postProcess: event.target.value,
                            }))
                          }
                        >
                          <option value="none">Disabled</option>
                          <option value="interpolate">Smooth motion</option>
                          <option
                            value="upscale"
                            disabled={!upscaleSupported || Boolean(runtimePostProcess && !runtimePostProcess.includes("upscale"))}
                          >
                            2x upscale
                          </option>
                          <option
                            value="both"
                            disabled={!upscaleSupported || Boolean(runtimePostProcess && !runtimePostProcess.includes("both"))}
                          >
                            Smooth + 2x upscale
                          </option>
                        </select>
                      </label>
                      <label>
                        <span>Scale</span>
                        <input value={upscaleEnabled ? "2x fixed" : "Off"} disabled readOnly />
                      </label>
                      <label>
                        <span>Quality</span>
                        <input value={upscaleEnabled ? "High - CRF 18" : "Draft"} disabled readOnly />
                      </label>
                    </div>
                  </div>
                  <Field
                    label="Output format"
                    help="MP4 has the broadest playback compatibility; WebM is a modern web-focused container."
                  >
                    <select
                      value={form.outputFormat}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          outputFormat: event.target.value,
                        }))
                      }
                    >
                      <option value="mp4">MP4</option>
                      <option value="webm">WebM</option>
                    </select>
                  </Field>
                </div>
                <div
                  className="lf-field prompt-field"
                  data-help="List unwanted artefacts or visual behaviour once here; it will be applied consistently to every scene."
                >
                  <div className="prompt-field-heading">
                    <span className="lf-label">Negative prompt</span>
                    <PromptSuggestion
                      value={form.negativePrompt}
                      suggestion="Avoid low quality, blurry frames, jittery motion, warped anatomy, duplicate subjects, identity drift, discontinuous lighting, unreadable text, watermarks and abrupt cuts."
                      expansion="Also exclude compression artefacts, unstable motion, inconsistent identity or wardrobe, continuity breaks, unwanted text, lighting shifts and anything that conflicts with the film's visual language."
                      kind="negative"
                      onUse={(suggestion) =>
                        setForm((current) =>
                          markAcceptedClipsStale(
                            { ...current, negativePrompt: suggestion },
                            "The shared negative prompt changed after this clip was accepted. Render this scene again before assembly.",
                          ),
                        )
                      }
                    />
                  </div>
                  <textarea
                    className="lf-negative"
                    aria-label="Shared negative prompt"
                    value={form.negativePrompt}
                    placeholder="Describe unwanted styles, artefacts or continuity problems…"
                    onChange={(event) =>
                      setForm((current) =>
                        markAcceptedClipsStale(
                          { ...current, negativePrompt: event.target.value },
                          "The shared negative prompt changed after this clip was accepted. Render this scene again before assembly.",
                        ),
                      )
                    }
                  />
                </div>
                <div className="lf-capability-note" role="status">
                  <strong>Verified production controls</strong>
                  <p>
                    Start/end frames:{" "}
                    {runtimeFeatureStatus.startFrame ?? "supported"}; draft
                    version stacks:{" "}
                    {runtimeFeatureStatus.candidates ?? "client_managed"};
                    technical quality checks:{" "}
                    {runtimeFeatureStatus.qualityAssessment ?? "partial"}.
                  </p>
                  <p>
                    Retake, extend, generative reframe, video modification,
                    identity-reference conditioning and HDR remain unavailable
                    until their runtime workflows produce acceptance evidence.
                  </p>
                </div>
              </div>
            </details>
          )}
          <Preview
            generation={currentGeneration}
            preservedGeneration={preservedGeneration}
            loading={isRendering}
            submissionError={mutation.error?.message}
            canGenerate={canGenerateNow}
            generateLabel={
              mutation.isPending
                ? "◌ Generating video…"
                : isClassic
                  ? "Generate video"
                  : "Generate complete film in one run"
            }
            onGenerate={() => mutation.mutate()}
            cancelling={cancellation.isPending}
            onCancel={() => cancellation.mutate()}
            cancelError={cancellation.error?.message}
            directorBusy={directorRepair.isPending}
            onAskDirectorRepair={(error) =>
              directorRepair.mutate({
                selectedSceneId: generationSceneId(currentGeneration),
                message: directorRepairMessage(
                  error,
                  generationSceneId(currentGeneration) ? "scene" : "project",
                ),
              })
            }
            minimal={isClassic}
            aspectRatio={minimalAspectRatio(form.resolution)}
            headerControls={isClassic ? sessionControls : undefined}
            videoSettingsPanel={videoSettingsPanel}
          />
          {!isClassic && (
            <History generations={history} onSelect={pinSelected} />
          )}
        </aside>
      </div>
      {projectDialogOpen && (
        <div
          className="lf-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setProjectDialogOpen(false);
          }}
        >
          <section
            className="lf-panel lf-projects lf-project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-modal-title"
          >
            <div className="lf-section-head">
              <div>
                <span className="lf-label">Your projects</span>
                <h2 id="project-modal-title">New project</h2>
              </div>
              <button
                type="button"
                className="lf-delete"
                aria-label="Close project dialog"
                onClick={() => setProjectDialogOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="lf-project-actions">
              <button
                type="button"
                className="lf-outline"
                disabled={projectBusy}
                onClick={() => void createProject()}
              >
                New project
              </button>
              <button
                type="button"
                className="lf-delete"
                disabled={projectBusy || projects.length <= 1}
                onClick={() => void removeProject()}
              >
                Delete project
              </button>
            </div>
            <div className="lf-project-fields">
              <label>
                <span>Open project</span>
                <select
                  aria-label="Open storyboard project"
                  value={projectId}
                  disabled={projectBusy}
                  onChange={(event) => void openProject(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title} · {project.sceneCount} scene
                      {project.sceneCount === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Project title</span>
                <input
                  aria-label="Project title"
                  value={projectTitle}
                  maxLength={120}
                  onChange={(event) => setProjectTitle(event.target.value)}
                  onBlur={() =>
                    setProjectTitle((title) => title.trim() || "Untitled film")
                  }
                  required
                />
              </label>
            </div>
            <p>
              Projects, prompts, generated frame references and accepted clips
              are private to your account and reopen across sessions.
            </p>
            {projectError && (
              <p className="lf-error" role="alert">
                {projectError}
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children?: React.ReactNode;
}) {
  return (
    <label className="lf-field" data-help={help}>
      <span className="lf-label">{label}</span>
      {children}
    </label>
  );
}
function IconField({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <label className="lf-icon-field" title={label}>
      <span className="lf-icon-field-glyph" aria-hidden="true">
        {icon}
      </span>
      {children}
    </label>
  );
}
function Range({
  label,
  help,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} help={help}>
      <div className="lf-range">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output>{value}</output>
      </div>
    </Field>
  );
}

function ProjectReferencePanel({
  references,
  sceneIds,
  evidence,
  onChange,
  globalSeed,
  seedPolicy,
  onSeedPolicyChange,
  onGlobalSeedChange,
  referenceConditioningSupported,
  onToggleSceneReference,
}: {
  references: StoryboardProjectReference[];
  sceneIds: string[];
  evidence: LongFormGenerationPayload["referencePlanningEvidence"];
  onChange: (references: StoryboardProjectReference[]) => void;
  globalSeed: number;
  seedPolicy: LongFormGenerationPayload["seedPolicy"];
  onSeedPolicyChange: (seedPolicy: LongFormGenerationPayload["seedPolicy"]) => void;
  onGlobalSeedChange: (globalSeed: number) => void;
  referenceConditioningSupported: boolean;
  onToggleSceneReference: (sceneId: string, referenceId: string, attached: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] =
    useState<StoryboardProjectReference["type"]>("character");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [traits, setTraits] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addReference = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError("");
    try {
      const assetId = await storeUserAsset(file, "projectReference");
      onChange([
        ...references,
        {
          id: crypto.randomUUID(),
          type,
          label: label.trim(),
          description: description.trim(),
          lockedTraits: traits
            .split(",")
            .map((trait) => trait.trim())
            .filter(Boolean)
            .slice(0, 24),
          sceneIds: [],
          ...(assetId ? { assetId } : {}),
          assetVersionIds: assetId ? [assetId] : [],
          version: 1,
        },
      ]);
      setLabel("");
      setDescription("");
      setTraits("");
      setFile(undefined);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "The private reference could not be added.",
      );
    } finally {
      setBusy(false);
    }
  };
  const updateReference = (
    id: string,
    patch: Partial<StoryboardProjectReference>,
  ) =>
    onChange(
      references.map((reference) =>
        reference.id === id ? { ...reference, ...patch } : reference,
      ),
    );
  const replaceFile = async (
    reference: StoryboardProjectReference,
    replacement?: File,
  ) => {
    if (!replacement) return;
    setBusy(true);
    setError("");
    try {
      const assetId = await storeUserAsset(replacement, "projectReference");
      if (assetId)
        updateReference(reference.id, {
          assetId,
          assetVersionIds: [...reference.assetVersionIds, assetId].slice(-24),
          version: reference.version + 1,
        });
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "The private reference could not be replaced.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lf-reference-panel">
      <button
        type="button"
        className="lf-reference-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="lf-reference-icon">▧</span>
        <span>
          <strong>Project references</strong>
          <small>
            Characters, places, products, style and voice direction ·{" "}
            {references.length} saved
          </small>
        </span>
        <b>{open ? "⌃" : "⌄"}</b>
      </button>
      {open && (
        <div className="lf-project-references">
          <p className="lf-capability-note">
            {referenceConditioningSupported
              ? "Gemma uses these private descriptions as continuity locks, and the connected runtime conditions generation on them directly, alongside start/end frame conditioning."
              : "Gemma uses these private descriptions as continuity locks. The current LTX workflow supports actual start/end frame conditioning; other reference media remain planning-only until runtime capability evidence is available."}
          </p>
          <div className="lf-seed-controls">
            <Field
              label="Visual seed policy"
              help="A locked seed gives every scene the same identity anchor. Scene overrides allow deliberate variation without random drift."
            >
              <select
                value={seedPolicy}
                onChange={(event) =>
                  onSeedPolicyChange(
                    event.target.value as
                      LongFormGenerationPayload["seedPolicy"],
                  )
                }
              >
                <option value="global_locked">
                  Lock one seed across the film
                </option>
                <option value="scene_overrides">
                  Allow deliberate scene overrides
                </option>
              </select>
            </Field>
            <NumberField
              label="Global visual seed"
              help="Keeps reproducible visual choices across the film. It does not replace prompt or frame continuity."
              value={globalSeed}
              min={0}
              max={999999999}
              step={1}
              onChange={onGlobalSeedChange}
            />
          </div>
          <div className="lf-reference-create">
            <Field label="Reference type">
              <select
                value={type}
                onChange={(event) =>
                  setType(
                    event.target.value as StoryboardProjectReference["type"],
                  )
                }
              >
                {(
                  [
                    "character",
                    "location",
                    "product",
                    "style",
                    "voice",
                    "motion",
                  ] as const
                ).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Friendly name">
              <input
                value={label}
                maxLength={120}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <Field label="How to use it">
              <textarea
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field
              label="Locked traits"
              help="Comma-separated details that should not drift."
            >
              <input
                value={traits}
                onChange={(event) => setTraits(event.target.value)}
              />
            </Field>
            <Field label="Optional private image">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => setFile(event.target.files?.[0])}
              />
            </Field>
            <button
              type="button"
              className="lf-outline"
              disabled={busy || !label.trim()}
              onClick={() => void addReference()}
            >
              {busy ? "Saving…" : "Add reference"}
            </button>
          </div>
          {error && (
            <p className="lf-error" role="alert">
              {error}
            </p>
          )}
          <div className="lf-reference-grid">
            {references.map((reference) => (
              <article
                key={reference.id}
                className="lf-reference-card has-file"
              >
                <ProjectReferencePreview reference={reference} />
                <strong>{reference.label}</strong>
                <ReferencePlanningStatus
                  reference={reference}
                  sceneIds={sceneIds}
                  evidence={evidence}
                />
                <small>
                  {reference.type} · version {reference.version}
                </small>
                {reference.assetVersionIds.length > 1 && (
                  <select
                    aria-label={`${reference.label} media version`}
                    value={reference.assetId}
                    onChange={(event) =>
                      updateReference(reference.id, {
                        assetId: event.target.value,
                        version:
                          reference.assetVersionIds.indexOf(
                            event.target.value,
                          ) + 1,
                      })
                    }
                  >
                    {reference.assetVersionIds.map((assetId, versionIndex) => (
                      <option key={assetId} value={assetId}>
                        Media version {versionIndex + 1}
                      </option>
                    ))}
                  </select>
                )}
                <textarea
                  value={reference.description}
                  aria-label={`${reference.label} usage`}
                  onChange={(event) =>
                    updateReference(reference.id, {
                      description: event.target.value,
                    })
                  }
                />
                <input
                  value={reference.lockedTraits.join(", ")}
                  aria-label={`${reference.label} locked traits`}
                  onChange={(event) =>
                    updateReference(reference.id, {
                      lockedTraits: event.target.value
                        .split(",")
                        .map((trait) => trait.trim())
                        .filter(Boolean)
                        .slice(0, 24),
                    })
                  }
                />
                <details>
                  <summary>Assign to scenes</summary>
                  {sceneIds.map((sceneId, sceneIndex) => (
                    <label key={sceneId} className="lf-toggle">
                      <input
                        type="checkbox"
                        checked={reference.sceneIds.includes(sceneId)}
                        onChange={(event) => {
                          updateReference(reference.id, {
                            sceneIds: event.target.checked
                              ? [...reference.sceneIds, sceneId]
                              : reference.sceneIds.filter(
                                  (id) => id !== sceneId,
                                ),
                          });
                          onToggleSceneReference(
                            sceneId,
                            reference.id,
                            event.target.checked,
                          );
                        }}
                      />
                      <span /> Scene {sceneIndex + 1}
                    </label>
                  ))}
                  <small>
                    No selected scenes means the reference applies project-wide.
                  </small>
                </details>
                <label className="lf-outline">
                  Replace image
                  <input
                    hidden
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) =>
                      void replaceFile(reference, event.target.files?.[0])
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    onChange(
                      references.filter((item) => item.id !== reference.id),
                    )
                  }
                >
                  Remove from project
                </button>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ReferencePlanningStatus({
  reference,
  sceneIds,
  evidence,
}: {
  reference: StoryboardProjectReference;
  sceneIds: string[];
  evidence: LongFormGenerationPayload["referencePlanningEvidence"];
}) {
  if (!evidence)
    return (
      <p className="lf-reference-evidence muted">
        Not analysed by the Director yet.
      </p>
    );
  const state = evidence.referenceStates.find(
    (item) => item.referenceId === reference.id,
  );
  const shotNumbers = reference.sceneIds
    .map((sceneId) => sceneIds.indexOf(sceneId) + 1)
    .filter((shotNumber) => shotNumber > 0);
  const stale =
    !state ||
    state.version !== reference.version ||
    JSON.stringify(state.shotNumbers) !== JSON.stringify(shotNumbers);
  const analysis = evidence.visualReferenceAnalyses.find(
    (item) => item.referenceId === reference.id,
  );
  const visuallyAttached = evidence.vision.attachedReferenceIds.includes(
    reference.id,
  );
  const textOnly = evidence.vision.textOnlyReferenceIds.includes(reference.id);
  const status = stale
    ? "Stale analysis"
    : visuallyAttached
      ? "Visual used"
      : textOnly
        ? "Text only"
        : "Not used";
  return (
    <div className={`lf-reference-evidence ${stale ? "stale" : ""}`}>
      <b>{status}</b>
      {stale && (
        <small>
          The reference version or scene scope changed. Ask the Director again
          to refresh this evidence.
        </small>
      )}
      {!stale && analysis && (
        <>
          {analysis.observedTraits.length > 0 && (
            <p>{analysis.observedTraits.join(" · ")}</p>
          )}
          <small>{analysis.continuityGuidance}</small>
          {analysis.declaredVisibleConflicts.map((conflict) => (
            <em key={conflict}>{conflict}</em>
          ))}
        </>
      )}
    </div>
  );
}

function ProjectReferencePreview({
  reference,
}: {
  reference: StoryboardProjectReference;
}) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (!reference.assetId) {
      setPreview("");
      return;
    }
    void fetchUserAsset(reference.assetId)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview(objectUrl);
      })
      .catch(() => setPreview(""));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reference.assetId]);
  return preview ? (
    <img src={preview} alt={`${reference.label} private reference`} />
  ) : (
    <div className="lf-reference-preview">No media preview</div>
  );
}

function _LongFormReferencePanel({
  references,
  onChange,
}: {
  references: LongFormReference[];
  onChange: (references: LongFormReference[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedCount = references.filter((reference) => reference.file).length;
  const updateReference = (index: number, next: LongFormReference) =>
    onChange(
      references.map((reference, referenceIndex) =>
        referenceIndex === index ? next : reference,
      ),
    );
  return (
    <section className={`lf-reference-panel ${open ? "open" : ""}`}>
      <button
        type="button"
        className="lf-reference-summary"
        data-help="Open optional image guidance for composition, recurring character identity and the film's overall visual style."
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="lf-reference-icon">▧</span>
        <span>
          <strong>Reference images, characters and style</strong>
          <small>
            Optional visual guidance ·{" "}
            {selectedCount ? `${selectedCount} selected` : "collapsed"}
          </small>
        </span>
        <span className="lf-reference-chips">
          <i>Reference image</i>
          <i>Character(s)</i>
          <i>Style</i>
        </span>
        <b>{open ? "⌃" : "⌄"}</b>
      </button>
      {open && (
        <div className="lf-reference-grid">
          {references.map((reference, index) => (
            <ReferenceCard
              key={reference.role}
              reference={reference}
              onChange={(next) => updateReference(index, next)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReferenceCard({
  reference,
  onChange,
}: {
  reference: LongFormReference;
  onChange: (reference: LongFormReference) => void;
}) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!reference.file) {
      setPreview("");
      return;
    }
    const objectUrl = URL.createObjectURL(reference.file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [reference.file]);
  return (
    <article
      className={`lf-reference-card ${reference.file ? "has-file" : ""}`}
    >
      <div className="lf-reference-card-head">
        <strong>{reference.label}</strong>
        {reference.file && (
          <button
            type="button"
            data-help={`Remove the current ${reference.label.toLowerCase()} from this storyboard.`}
            onClick={() =>
              onChange({ ...reference, file: undefined, preview: undefined })
            }
          >
            Remove
          </button>
        )}
      </div>
      <label className="lf-reference-preview" data-help={reference.helper}>
        {preview ? (
          <img src={preview} alt={`${reference.label} preview`} />
        ) : (
          <>
            <span>▧</span>
            <b>Upload image</b>
            <small>PNG, JPEG or WebP</small>
          </>
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onChange({ ...reference, file, preview: undefined });
          }}
        />
      </label>
      <p>{reference.helper}</p>
      <label
        className="lf-reference-strength"
        data-help="Controls how strongly this image influences generation. Lower values are suggestive; higher values follow it more closely."
      >
        <span>
          Strength <b>{reference.strength.toFixed(2)}</b>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={reference.strength}
          onChange={(event) =>
            onChange({ ...reference, strength: Number(event.target.value) })
          }
        />
      </label>
      {reference.file && (
        <small className="lf-reference-filename">{reference.file.name}</small>
      )}
    </article>
  );
}

function SceneCard({
  scene,
  creatorPrompt,
  index,
  count,
  onChange,
  onCreatorPromptChange,
  onMove,
  onRemove,
  frameState,
  onGenerateFrame,
  onRegeneratePrompt,
  promptBusy,
  renderState,
  onRender,
  onAskDirectorRepair,
  onAskDirectorSound,
  onAcceptCandidate,
  globalSeed,
  seedPolicy,
  classic,
  negativePrompt,
  stopGeneratedText,
  onStopGeneratedTextChange,
  onNegativePromptChange,
  previewGate,
  generateAction,
}: {
  scene: StoryboardScenePayload;
  creatorPrompt?: string;
  index: number;
  count: number;
  onChange: (patch: Partial<StoryboardScenePayload>) => void;
  onCreatorPromptChange?: (value: string) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  frameState: { start: FrameState; end: FrameState };
  onGenerateFrame: (edge: "start" | "end") => void;
  onRegeneratePrompt: () => void;
  promptBusy: boolean;
  renderState: SceneRenderState;
  onRender: () => void;
  onAskDirectorRepair: (error: string) => void;
  onAskDirectorSound: () => void;
  onAcceptCandidate: (generationId: string) => void;
  globalSeed: number;
  seedPolicy: LongFormGenerationPayload["seedPolicy"];
  classic?: boolean;
  negativePrompt?: string;
  stopGeneratedText?: boolean;
  onStopGeneratedTextChange?: (enabled: boolean) => void;
  onNegativePromptChange?: (value: string) => void;
  previewGate?: React.ReactNode;
  generateAction?: React.ReactNode;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(index === 0);
  const [activeSoundTab, setActiveSoundTab] = useState<SceneSoundTabKey>(() =>
    sceneSoundTabForIntent(scene),
  );
  useEffect(() => {
    setActiveSoundTab(sceneSoundTabForIntent(scene));
  }, [scene.audioIntent?.mode]);
  const selectedTransition =
    transitionOptions.find((option) => option.value === scene.transition) ??
    transitionOptions[0];
  const suggestion =
    index === 0
      ? "Wide street-level tracking shot. The founder notices a thin teal reflection moving through puddles. Keep the face and trench coat consistent; slow handheld pursuit; cool rain and warm shop windows."
      : "Begin from the previous final frame. The signal climbs a bridge rail as the camera arcs around the founder, revealing the skyline. Preserve direction of travel, identity, wet materials and the restrained teal-and-amber palette.";
  const activeSound = sceneSoundTabs.find((tab) => tab.key === activeSoundTab) ?? sceneSoundTabs[0];
  const visiblePrompt = classic ? (creatorPrompt ?? "") : scene.prompt;
  const updateSoundIntent = (key: SceneSoundTabKey, value: string) => {
    const nextIntent = {
      mode: scene.audioIntent?.mode ?? "silent",
      reason: scene.audioIntent?.reason ?? "",
      dialogue: scene.audioIntent?.dialogue ?? "",
      ambience: scene.audioIntent?.ambience ?? "",
      soundEffects: scene.audioIntent?.soundEffects ?? "",
      music: scene.audioIntent?.music ?? "",
      silence: scene.audioIntent?.silence ?? "",
      [key]: value,
    };
    const enabledModes = sceneSoundTabs
      .filter((tab) => tab.key !== "silence" && String(nextIntent[tab.key] ?? "").trim())
      .map((tab) => tab.mode);
    onChange({
      audioIntent: {
        ...nextIntent,
        mode:
          enabledModes.length > 1
            ? "mixed"
            : enabledModes[0] ?? (String(nextIntent.silence).trim() ? "silent" : "silent"),
        reason: sceneSoundTabs
          .map((tab) => [tab.label, String(nextIntent[tab.key] ?? "").trim()] as const)
          .filter(([, note]) => note)
          .map(([label, note]) => `${label}: ${note}`)
          .join("\n"),
      },
    });
  };
  return (
    <article className={expanded ? "lf-scene" : "lf-scene collapsed"}>
      {!classic && (
      <header>
        <button
          type="button"
          className="lf-scene-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} scene ${index + 1}`}
          onClick={() => setExpanded((value) => !value)}
        />
        {!classic && (
          <>
            <button
              data-help="Move this scene one position earlier in the film."
              disabled={index === 0}
              title="Move scene up"
              onClick={() => onMove(-1)}
            >
              ↑
            </button>
            <button
              data-help="Move this scene one position later in the film."
              disabled={index === count - 1}
              title="Move scene down"
              onClick={() => onMove(1)}
            >
              ↓
            </button>
          </>
        )}
        {!classic && (
          <PromptSuggestion
            label={
              scene.prompt.trim()
                ? `Expand scene ${index + 1}`
                : `Show a suggestion for scene ${index + 1}`
            }
            value={scene.prompt}
            suggestion={suggestion}
            expansion="Develop this scene with one precise subject action, motivated camera movement, lens and framing, lighting progression, continuity from the previous frame and a deliberate final composition that leads into the next scene."
            kind="storyboard-scene"
            onUse={(value) =>
              onChange({ prompt: value, promptOrigin: "agent" })
            }
          />
        )}
        {!classic && (
          <button
            type="button"
            className="lf-regenerate-shot"
            disabled={promptBusy}
            onClick={onRegeneratePrompt}
          >
            Regenerate scene
          </button>
        )}
        {!classic && (
          <button
            className="lf-delete"
            aria-label={`Delete scene ${index + 1}`}
            data-help="Permanently remove this scene from the storyboard."
            disabled={count <= 1}
            title="Delete scene"
            onClick={onRemove}
          >
            <span aria-hidden="true">🗑</span> Delete
          </button>
        )}
      </header>
      )}
      {expanded ? (
        <>
          <div
            className="prompt-field scene-prompt-field"
            data-help={
              classic
                ? "Describe one story beat: subject action, camera movement, lighting change and the final composition."
                : "Describe one story beat: subject action, camera movement, lighting change and the final frame that leads into the following scene."
            }
          >
            <div className="prompt-field-heading">
              <span className="lf-label">{classic ? "Video prompt" : "Scene direction"}</span>
              {!classic && (
                <small>
                  {scene.promptOrigin === "agent"
                    ? "Gemma suggestion"
                    : "Your direction"}
                </small>
              )}
              {classic && (
                <button
                  type="button"
                  className="lf-outline lf-regenerate-shot"
                  disabled={promptBusy}
                  onClick={onRegeneratePrompt}
                >
                  {promptBusy ? "Working…" : "Regenerate scene"}
                </button>
              )}
            </div>
            <textarea
              aria-label={classic ? "Video prompt" : `Scene ${index + 1} direction`}
              value={visiblePrompt}
              placeholder={
                classic
                  ? "Describe the video you want to create..."
                  : "Describe one clear action, camera movement, lighting beat and final composition..."
              }
              onChange={(event) => {
                if (classic && onCreatorPromptChange) {
                  onCreatorPromptChange(event.target.value);
                  return;
                }
                onChange({
                  prompt: event.target.value,
                  promptOrigin: "user",
                  staleReason:
                    scene.startFrame ||
                    scene.endFrame ||
                    scene.acceptedVideoGenerationId
                      ? "This direction changed after its frame anchors were created. Review or regenerate them before rendering."
                      : scene.staleReason,
                });
              }}
            />
            {!classic && (
              <div className="lf-scene-copy-grid">
                <label>
                  <span>Narrative purpose</span>
                  <textarea
                    aria-label={`Scene ${index + 1} narrative purpose`}
                    value={scene.narrativePurpose ?? ""}
                    placeholder="What changes in the story during this scene?"
                    onChange={(event) =>
                      onChange({ narrativePurpose: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>Continuity handoff summary</span>
                  <textarea
                    aria-label={`Scene ${index + 1} continuity summary`}
                    value={scene.summary ?? ""}
                    placeholder="Briefly describe the ending state that the next scene inherits."
                    onChange={(event) =>
                      onChange({
                        summary: event.target.value,
                        staleReason: scene.acceptedVideoGenerationId
                          ? "The continuity handoff changed after this clip was rendered. Render this scene again before assembly."
                          : scene.staleReason,
                      })
                    }
                  />
                </label>
              </div>
            )}
          </div>
          {classic && generateAction}
          {!classic && (
            <div className="lf-scene-fields">
              <NumberField
                label="Duration"
                help="The full generated and delivered length of this scene."
                value={scene.duration}
                min={1}
                max={8}
                step={1}
                onChange={(value) =>
                  onChange({
                    duration: value,
                    trimStart: 0,
                    trimEnd: value,
                    staleReason: scene.acceptedVideoGenerationId
                      ? "The scene duration changed after its accepted clip was rendered. Render this scene again before assembly."
                      : scene.staleReason,
                  })
                }
              />
              {index === 0 ? (
                <Field
                  label="Transition in"
                  help="The first scene opens the film, so it has no incoming transition."
                >
                  <div className="lf-disabled">Opening scene</div>
                </Field>
              ) : (
                <Field
                  label="Transition in"
                  help="Choose how the previous scene blends or cuts into this one."
                >
                  <button
                    className="lf-transition-button"
                    onClick={() => setPickerOpen(true)}
                  >
                    <b>{selectedTransition.glyph}</b>
                    <span>{selectedTransition.label}</span>
                    <i>›</i>
                  </button>
                </Field>
              )}
            </div>
          )}
          {!classic && (
            <details className="lf-scene-advanced">
              <summary>Continuity and seed</summary>
              <label className="lf-toggle">
                <input
                  type="checkbox"
                  checked={index > 0 && scene.carryPreviousFrame}
                  disabled={index === 0}
                  onChange={(event) =>
                    onChange({ carryPreviousFrame: event.target.checked })
                  }
                />
                <span />
                {index === 0
                  ? "Opening scene has no previous frame"
                  : "Use the previous clip’s real last frame during a complete-film render"}
              </label>
              <div className="lf-seed-controls">
                <label className="lf-toggle">
                  <input
                    type="checkbox"
                    checked={scene.seedOverrideEnabled === true}
                    disabled={seedPolicy !== "scene_overrides"}
                    onChange={(event) =>
                      onChange({ seedOverrideEnabled: event.target.checked })
                    }
                  />
                  <span /> Use a different seed for this scene
                </label>
                <NumberField
                  label="Effective scene seed"
                  value={scene.seedOverrideEnabled ? scene.seed : globalSeed}
                  min={0}
                  max={999999999}
                  step={1}
                  onChange={(seed) =>
                    onChange({ seed, seedOverrideEnabled: true })
                  }
                />
              </div>
              <details className="lf-continuity-details">
                <summary>Override continuity for this scene only</summary>
                <div className="lf-continuity-grid">
                  {continuityFields.map(([key, label]) => (
                    <label key={key}>
                      <span>{label}</span>
                      <textarea
                        aria-label={`Scene ${index + 1} ${label} override`}
                        value={scene.continuityOverrides?.[key] ?? ""}
                        placeholder="Leave blank to inherit the film bible."
                        onChange={(event) =>
                          onChange({
                            continuityOverrides: {
                              ...(scene.continuityOverrides ?? {}),
                              [key]: event.target.value,
                            },
                            staleReason: scene.acceptedVideoGenerationId
                              ? "A continuity override changed after this clip was rendered. Render this scene again before assembly."
                              : scene.staleReason,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </details>
            </details>
          )}
          {(() => {
            const advancedInner = (
              <>
          <details className="lf-frame-details">
            <summary>First frame / last frame</summary>
            <div className="lf-frames">
              <FrameControl
                edge="start"
                file={scene.startFrame}
                prompt={scene.firstFramePrompt ?? ""}
                state={frameState.start}
                onPrompt={(firstFramePrompt) =>
                  onChange({ firstFramePrompt, promptOrigin: "user" })
                }
                onFile={(startFrame) =>
                  onChange({
                    startFrame,
                    startFrameGenerationId: undefined,
                    staleReason:
                      "The opening frame changed after the previous storyboard render. Generate the film again to use it.",
                  })
                }
                onGenerate={() => onGenerateFrame("start")}
                onAskDirectorRepair={(error) => onAskDirectorRepair(error)}
              />
              <FrameControl
                edge="end"
                file={scene.endFrame}
                prompt={scene.lastFramePrompt ?? ""}
                state={frameState.end}
                onPrompt={(lastFramePrompt) =>
                  onChange({ lastFramePrompt, promptOrigin: "user" })
                }
                onFile={(endFrame) =>
                  onChange({
                    endFrame,
                    endFrameGenerationId: undefined,
                    staleReason:
                      "The closing frame changed after the previous storyboard render. Generate the film again to use it.",
                  })
                }
                onGenerate={() => onGenerateFrame("end")}
                onAskDirectorRepair={(error) => onAskDirectorRepair(error)}
              />
            </div>
            {previewGate}
          </details>
          {classic && (
            <details className="lf-frame-details lf-negative-details">
              <summary>Negative prompt</summary>
              <div className="lf-negative-panel">
                <label className="lf-toggle lf-generated-text-lock">
                  <input
                    type="checkbox"
                    checked={stopGeneratedText ?? true}
                    onChange={(event) =>
                      onStopGeneratedTextChange?.(event.target.checked)
                    }
                    aria-label="Stop captions and readable text"
                  />
                  <span />
                  Stop captions and readable text
                </label>
                <textarea
                  className="lf-negative"
                  aria-label="Shared negative prompt"
                  value={negativePrompt ?? ""}
                  placeholder="Describe unwanted styles, artefacts or continuity problems…"
                  onChange={(event) =>
                    onNegativePromptChange?.(event.target.value)
                  }
                />
              </div>
            </details>
          )}
          {classic && (
            <details className="lf-frame-details lf-creator-scene-details">
              <summary>Scene purpose, continuity and sound</summary>
              <div className="lf-scene-copy-grid">
                <label>
                  <span>Narrative purpose</span>
                  <textarea
                    aria-label={`Scene ${index + 1} narrative purpose`}
                    value={scene.narrativePurpose ?? ""}
                    placeholder="What changes in the story during this scene?"
                    onChange={(event) => onChange({ narrativePurpose: event.target.value })}
                  />
                </label>
                <label>
                  <span>Continuity handoff</span>
                  <textarea
                    aria-label={`Scene ${index + 1} continuity notes`}
                    value={scene.continuityNotes ?? ""}
                    placeholder="What must the next scene preserve?"
                    onChange={(event) => onChange({ continuityNotes: event.target.value })}
                  />
                </label>
                <div className="lf-scene-sound-editor">
                  <div className="lf-scene-sound-tabs" role="tablist" aria-label={`Scene ${index + 1} sound intent`}>
                    {sceneSoundTabs.map((tab) => {
                      const hasNote = Boolean(String(scene.audioIntent?.[tab.key] ?? "").trim());
                      return (
                        <button
                          key={tab.key}
                          type="button"
                          role="tab"
                          aria-selected={activeSoundTab === tab.key}
                          className={activeSoundTab === tab.key ? "active" : ""}
                          onClick={() => setActiveSoundTab(tab.key)}
                        >
                          <span>{tab.label}</span>
                          {hasNote && <small />}
                        </button>
                      );
                    })}
                  </div>
                  <label className="lf-scene-sound-field">
                    <span>{activeSound.label} direction</span>
                    <textarea
                      aria-label={`Scene ${index + 1} ${activeSound.label.toLowerCase()} sound direction`}
                      value={scene.audioIntent?.[activeSound.key] ?? ""}
                      placeholder={activeSound.placeholder}
                      onChange={(event) => updateSoundIntent(activeSound.key, event.target.value)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="lf-outline lf-scene-sound-director"
                  disabled={promptBusy}
                  onClick={onAskDirectorSound}
                >
                  Ask Director for sound
                </button>
              </div>
            </details>
          )}
              </>
            );
            return classic ? (
              <details className="lf-frame-details lf-advanced-options">
                <summary>Advanced options</summary>
                {advancedInner}
              </details>
            ) : (
              advancedInner
            );
          })()}
          {!classic && (
            <label className="lf-continuity-note">
              <span>Continuity notes</span>
              <textarea
                aria-label={`Scene ${index + 1} continuity notes`}
                value={scene.continuityNotes ?? ""}
                placeholder="Record details the next shot should preserve."
                onChange={(event) =>
                  onChange({ continuityNotes: event.target.value })
                }
              />
            </label>
          )}
          {!classic && scene.staleReason && (
            <p className="lf-stale-note" role="status">
              {scene.staleReason}
            </p>
          )}
          {!classic && (
            <>
              <div className="lf-scene-render">
                <div>
                  <strong>
                    {scene.acceptedVideoGenerationId
                      ? scene.staleReason
                        ? "Accepted clip needs review"
                        : "Accepted clip ready"
                      : "No accepted clip yet"}
                  </strong>
                  <small>
                    Draft candidates render one at a time for queue fairness.
                    Previous versions and the accepted clip remain available.
                  </small>
                </div>
                <button
                  type="button"
                  className="lf-primary"
                  disabled={
                    renderState.status === "queued" ||
                    renderState.status === "generating" ||
                    !scene.prompt.trim()
                  }
                  onClick={onRender}
                >
                  {renderState.status === "queued"
                    ? "Queued…"
                    : renderState.status === "generating"
                      ? "Rendering video title…"
                      : scene.candidateGenerationIds?.length
                        ? "Generate more drafts"
                        : "Generate draft candidates"}
                </button>
              </div>
              {renderState.status === "failed" && (
                <div className="lf-error lf-repair-callout" role="alert">
                  <p>
                    {renderState.error} The previous accepted clip is unchanged.
                  </p>
                  <button
                    type="button"
                    className="lf-outline"
                    disabled={promptBusy}
                    onClick={() =>
                      onAskDirectorRepair(
                        renderState.error ?? "The scene render failed.",
                      )
                    }
                  >
                    Ask Director to fix
                  </button>
                </div>
              )}
              {scene.acceptedVideoGenerationId && (
                <SceneAcceptedVideo
                  generationId={scene.acceptedVideoGenerationId}
                />
              )}
              {!!scene.candidateGenerationIds?.length && (
                <SceneCandidateStack
                  sceneNumber={index + 1}
                  generationIds={scene.candidateGenerationIds}
                  acceptedGenerationId={scene.acceptedVideoGenerationId}
                  onAccept={onAcceptCandidate}
                />
              )}
            </>
          )}
          {pickerOpen && (
            <TransitionPicker
              scene={scene}
              onChange={onChange}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </>
      ) : (
        <button
          type="button"
          className="lf-scene-collapsed-summary"
          onClick={() => setExpanded(true)}
        >
          {visiblePrompt.trim() ||
            (classic
              ? "Open this prompt to describe the video and add frame anchors."
              : "Open this scene to add direction, timing and render controls.")}
        </button>
      )}
    </article>
  );
}

function FrameControl({
  edge,
  file,
  prompt,
  state,
  onPrompt,
  onFile,
  onGenerate,
  onAskDirectorRepair,
}: {
  edge: "start" | "end";
  file?: File;
  prompt: string;
  state: FrameState;
  onPrompt: (value: string) => void;
  onFile: (file?: File) => void;
  onGenerate: () => void;
  onAskDirectorRepair: (error: string) => void;
}) {
  const label = edge === "start" ? "First frame" : "Last frame";
  const busy = state.status === "queued" || state.status === "generating";
  return (
    <section className="lf-frame-control">
      <UploadBox
        label={label}
        help={
          edge === "start"
            ? "The exact opening composition for this shot. The current successful image stays visible while a replacement is generated."
            : "The target closing composition for this shot and a visual handoff into the next one."
        }
        file={file}
        onFile={onFile}
      />
      <label className="lf-frame-prompt">
        <span>{label} direction</span>
        <textarea
          value={prompt}
          placeholder={`Describe the ${edge === "start" ? "opening" : "closing"} composition, subject placement, lighting and camera framing.`}
          onChange={(event) => onPrompt(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="lf-outline"
        disabled={busy || prompt.trim().length < 8}
        onClick={onGenerate}
      >
        {busy
          ? state.status === "queued"
            ? "Queued…"
            : "Generating…"
          : file
            ? `Regenerate ${label.toLowerCase()}`
            : `Generate ${label.toLowerCase()}`}
      </button>
      {state.status === "failed" && (
        <div className="lf-error lf-repair-callout" role="alert">
          <p>{state.error} Your previous frame is unchanged.</p>
          <button
            type="button"
            className="lf-outline"
            disabled={busy}
            onClick={() =>
              onAskDirectorRepair(state.error ?? `${label} generation failed.`)
            }
          >
            Ask Director to fix prompt
          </button>
        </div>
      )}
    </section>
  );
}

function SceneAcceptedVideo({ generationId }: { generationId: string }) {
  const generation = useQuery({
    queryKey: ["accepted-scene", generationId],
    queryFn: () => getGeneration(generationId),
  });
  if (generation.isLoading)
    return <div className="lf-scene-video">Loading accepted clip…</div>;
  if (
    generation.data?.status !== "completed" ||
    !generation.data.output?.downloadUrl
  )
    return (
      <p className="lf-error">
        The accepted clip is not currently available. Render this scene again.
      </p>
    );
  return (
    <div className="lf-scene-video">
      <AuthenticatedVideo downloadUrl={generation.data.output.downloadUrl} />
    </div>
  );
}

function SceneCandidateStack({
  sceneNumber,
  generationIds,
  acceptedGenerationId,
  onAccept,
}: {
  sceneNumber: number;
  generationIds: string[];
  acceptedGenerationId?: string;
  onAccept: (generationId: string) => void;
}) {
  const results = useQueries({
    queries: generationIds.map((generationId) => ({
      queryKey: ["scene-candidate", generationId],
      queryFn: () => getGeneration(generationId),
    })),
  });
  const ranked = generationIds
    .map((generationId, originalIndex) => ({
      generationId,
      originalIndex,
      generation: results[originalIndex]?.data,
    }))
    .sort((left, right) => {
      const leftScore = left.generation?.qualityAssessment?.score ?? -1;
      const rightScore = right.generation?.qualityAssessment?.score ?? -1;
      return rightScore - leftScore || left.originalIndex - right.originalIndex;
    });
  return (
    <div
      className="lf-candidate-stack"
      aria-label={`Scene ${sceneNumber} draft candidates`}
    >
      <strong>Draft version stack</strong>
      <small>
        Ranked by advisory technical checks; your creative choice remains
        authoritative.
      </small>
      <div className="lf-candidate-grid">
        {ranked.map((candidate, rankIndex) => (
          <SceneCandidateVideo
            key={candidate.generationId}
            generationId={candidate.generationId}
            label={`Draft ${candidate.originalIndex + 1}`}
            rank={
              candidate.generation?.qualityAssessment
                ? rankIndex + 1
                : undefined
            }
            accepted={acceptedGenerationId === candidate.generationId}
            onAccept={() => onAccept(candidate.generationId)}
          />
        ))}
      </div>
    </div>
  );
}

function SceneCandidateVideo({
  generationId,
  label,
  rank,
  accepted,
  onAccept,
}: {
  generationId: string;
  label: string;
  rank?: number;
  accepted: boolean;
  onAccept: () => void;
}) {
  const generation = useQuery({
    queryKey: ["scene-candidate", generationId],
    queryFn: () => getGeneration(generationId),
  });
  if (generation.isLoading)
    return (
      <article className="lf-candidate-card">
        Loading {label.toLowerCase()}…
      </article>
    );
  if (
    generation.data?.status !== "completed" ||
    !generation.data.output?.downloadUrl
  ) {
    return (
      <article className="lf-candidate-card">
        <strong>{label}</strong>
        <p className="lf-error">This draft is unavailable.</p>
      </article>
    );
  }
  const quality = generation.data.qualityAssessment;
  const issues =
    quality?.checks.filter(
      (check) => check.status === "failed" || check.status === "warning",
    ) ?? [];
  return (
    <article
      className={accepted ? "lf-candidate-card accepted" : "lf-candidate-card"}
    >
      <header>
        <strong>{label}</strong>
        <span>{accepted ? "Accepted" : rank ? `Rank ${rank}` : "Review"}</span>
      </header>
      <AuthenticatedVideo downloadUrl={generation.data.output.downloadUrl} />
      {quality && (
        <small>
          Quality score {quality.score}/100. Automated checks are advisory.{" "}
          {issues.length
            ? `${issues.length} issue${issues.length === 1 ? "" : "s"} need review.`
            : "No media-integrity issues were reported."}
        </small>
      )}
      <button
        type="button"
        className="lf-outline"
        disabled={accepted}
        onClick={onAccept}
      >
        {accepted ? "Selected draft" : "Use this draft"}
      </button>
    </article>
  );
}

function NumberField({
  label,
  help,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} help={help}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}
function UploadBox({
  label,
  help,
  compact = false,
  file,
  onFile,
}: {
  label: string;
  help?: string;
  compact?: boolean;
  file?: File;
  onFile: (file?: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const acceptFile = (candidate?: File) => {
    if (
      candidate &&
      ["image/jpeg", "image/png", "image/webp"].includes(candidate.type)
    )
      onFile(candidate);
  };
  return (
    <div
      className={`lf-upload ${compact ? "compact" : ""} ${file ? "has-file" : ""} ${dragging ? "is-dragging" : ""}`}
      data-help={help}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        acceptFile(event.dataTransfer.files?.[0]);
      }}
    >
      <button
        type="button"
        className="lf-upload-drop"
        data-help={`${file ? "Replace" : "Add"} this ${label.toLowerCase()} image. Supported formats are PNG, JPEG and WebP.`}
        aria-label={`${file ? "Replace" : "Add"} ${label.toLowerCase()}`}
        onClick={() => inputRef.current?.click()}
      >
        {preview && !compact ? (
          <img
            src={preview}
            alt={`${label} preview`}
            title="Double-click to preview"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setPreviewOpen(true);
            }}
          />
        ) : (
          <span aria-hidden="true" className="lf-upload-icon">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect
                x="3"
                y="4"
                width="18"
                height="16"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <circle cx="8.5" cy="9.5" r="1.75" fill="currentColor" />
              <path
                d="M4 17l5.2-5.2a1.5 1.5 0 0 1 2.12 0L15 15.4l1.4-1.4a1.5 1.5 0 0 1 2.12 0L21 16.6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
        <span className="lf-upload-copy">
          <strong>{label}</strong>
          {!file && <small>Click to browse or drop an image</small>}
        </span>
        <i>{file ? "Replace" : "+"}</i>
      </button>
      <input
        ref={inputRef}
        className="lf-upload-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          acceptFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {file && (
        <button
          type="button"
          className="lf-upload-remove"
          data-help={`Remove this ${label.toLowerCase()} so the scene can render without that image anchor.`}
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={() => onFile(undefined)}
        >
          Remove
        </button>
      )}
      {previewOpen && preview && (
        <div
          className="lf-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${label} preview`}
          onMouseDown={() => setPreviewOpen(false)}
        >
          <button
            type="button"
            aria-label="Close image preview"
            onClick={() => setPreviewOpen(false)}
          >
            Close
          </button>
          <img
            src={preview}
            alt={`${label} full preview`}
            onMouseDown={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
function TransitionPicker({
  scene,
  onChange,
  onClose,
}: {
  scene: StoryboardScenePayload;
  onChange: (patch: Partial<StoryboardScenePayload>) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="lf-modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        className="lf-transition-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Choose transition"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="lf-label">Video editor</span>
            <h2>Choose transition</h2>
          </div>
          <button
            type="button"
            aria-label="Close transition chooser"
            data-help="Close the transition chooser."
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="lf-transition-grid">
          {transitionOptions.map((option) => (
            <button
              key={option.value}
              data-help={`${option.description}. Select this as the incoming transition for the scene.`}
              className={scene.transition === option.value ? "selected" : ""}
              onClick={() => onChange({ transition: option.value })}
            >
              <span className="lf-transition-glyph">{option.glyph}</span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
        <footer>
          <div>
            <span className="lf-label">Duration</span>
            <strong>
              {scene.transition === "cut"
                ? "0.00"
                : scene.transitionDuration.toFixed(2)}
              s
            </strong>
          </div>
          <span
            className="lf-help-target"
            data-help="Controls how long the two clips overlap during the selected transition."
          >
            <input
              aria-label="Transition duration"
              type="range"
              min={0.25}
              max={2}
              step={0.05}
              disabled={scene.transition === "cut"}
              value={scene.transitionDuration}
              onChange={(event) =>
                onChange({ transitionDuration: Number(event.target.value) })
              }
            />
          </span>
          <button
            className="lf-primary"
            data-help="Keep the selected transition and return to the scene card."
            onClick={onClose}
          >
            Apply
          </button>
          <p>
            Video and audio overlap together. The final film becomes shorter by
            the selected transition duration.
          </p>
        </footer>
      </section>
    </div>
  );
}

function clampProgress(value: unknown, status?: Generation["status"]) {
  if (status === "completed") return 100;
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function humaniseRuntimeStage(value?: string) {
  if (!value) return undefined;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function generationFailureMessage(generation?: Generation) {
  if (!generation || generation.status !== "failed") return undefined;
  return (
    generation.safeErrorMessage ||
    generation.runtimeMessage ||
    "The render failed before a downloadable video was created."
  );
}

function generationSceneId(generation?: Generation) {
  const sceneId = generation?.settings.operationSceneId;
  return typeof sceneId === "string" && sceneId.trim() ? sceneId : undefined;
}

function directorRepairMessage(error: string, scope: "scene" | "project") {
  const captionFailure = /\b(caption|captions|subtitle|subtitles|visible text|generated text|readable text)\b/i.test(error);
  if (captionFailure) {
    return scope === "scene"
      ? `Fix this scene direction to prevent unwanted captions, subtitles, visible generated text, signage, logos and watermarks. Keep the creative intent, but rewrite the prompt so the next render avoids readable text. Runtime error: ${error}`
      : `Fix the storyboard to prevent unwanted captions, subtitles, visible generated text, signage, logos and watermarks across every scene. Keep the creative intent, but strengthen the direction and negative prompt so the next render avoids readable text. Runtime error: ${error}`;
  }
  return scope === "scene"
    ? `Review this failed scene render and fix the scene direction so it can be retried safely. Keep existing successful work unchanged. Runtime error: ${error}`
    : `Review this failed render and fix the storyboard so it can be retried safely. Keep existing successful work unchanged. Runtime error: ${error}`;
}

function directorProjectSoundMessage(mode: LongFormGenerationPayload["audioPolicy"]["mode"]) {
  if (mode === "silent") {
    return "Set the project sound policy to silent. Remove dialogue, music, ambience and sound effects unless the user later explicitly changes this.";
  }
  if (mode === "directed") {
    return "Review and direct the project sound design. Keep the current creative intent, but make the audio policy and scene sound notes explicit enough for generation and assembly.";
  }
  return "Make the project audio conservative: only include dialogue, ambience, sound effects or music when the scene explicitly asks for it. Avoid accidental music or mood-based sound.";
}

function directorSceneSoundMessage(sceneNumber: number, scene: StoryboardScenePayload) {
  return `Improve scene ${sceneNumber}'s sound direction. Current sound mode is ${scene.audioIntent?.mode ?? "silent"}. Current sound note: ${scene.audioIntent?.reason || "none"}. Keep the visual direction and continuity, but rewrite only the scene sound intent so the runtime knows whether to use dialogue, ambience, effects, music, mixed sound or silence.`;
}

function formatElapsed(createdAt?: string, now = Date.now()) {
  if (!createdAt) return "Session";
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(createdAt).getTime()) / 1000),
  );
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function Preview({
  generation,
  preservedGeneration,
  loading,
  submissionError,
  canGenerate,
  generateLabel,
  onGenerate,
  cancelling,
  onCancel,
  cancelError,
  directorBusy,
  onAskDirectorRepair,
  minimal = false,
  aspectRatio = "16:9",
  headerControls,
  videoSettingsPanel,
}: {
  generation?: Generation;
  preservedGeneration?: Generation;
  loading: boolean;
  submissionError?: string;
  canGenerate: boolean;
  generateLabel: string;
  onGenerate: () => void;
  cancelling: boolean;
  onCancel: () => void;
  cancelError?: string;
  directorBusy?: boolean;
  onAskDirectorRepair?: (error: string) => void;
  minimal?: boolean;
  aspectRatio?: MinimalAspectRatio;
  headerControls?: React.ReactNode;
  videoSettingsPanel?: React.ReactNode;
}) {
  const mediaGeneration = preservedGeneration ?? generation;
  const video = useAuthenticatedVideo(mediaGeneration?.output?.downloadUrl);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);
  const progress = clampProgress(generation?.progress, generation?.status);
  const rawProgress =
    typeof generation?.progress === "number" && Number.isFinite(generation.progress)
      ? generation.progress
      : 0;
  const hasRuntimeActivity =
    Boolean(generation?.runtimeMessage) ||
    Boolean(generation?.runtimeProgress) ||
    Boolean(rawProgress > 0 && generation?.status !== "completed");
  const statusLabel = generation?.status
    ? generation.status.replace("_", " ")
    : "Ready";
  const progressLabel =
    generation?.status === "completed"
      ? "Render complete"
      : generation?.status === "generating" || hasRuntimeActivity
        ? "Rendering video title"
      : generation?.status === "queued"
        ? "Preparing runtime"
        : generation?.status === "preparing"
          ? "Preparing render"
          : generation?.status === "uploading"
              ? "Finalising output"
              : loading
                ? "Rendering video title"
                : "Ready";
  const queueLabel =
    generation?.queuePosition && generation.queuePosition > 1
      ? `Queue position ${generation.queuePosition}`
      : "Waiting for the render worker";
  const activityLabel =
    generation?.runtimeMessage ||
    (hasRuntimeActivity
      ? "Runtime is processing the render"
      : generation?.status === "queued"
      ? queueLabel
      : `${statusLabel} with runtime`);
  const runtimeCounter = runtimeProgressCounter(generation);
  const runtimeStage = humaniseRuntimeStage(generation?.runtimeProgress?.stage);
  const failureMessage = generationFailureMessage(generation);
  const failureCode = generation?.failureCode
    ? humaniseRuntimeStage(generation.failureCode)
    : undefined;
  const visibleProgress =
    generation && generation.status !== "completed" && progress > 0
      ? `${progress}%`
      : undefined;

  const panel = (
    <section className="lf-preview lf-panel">
      <header data-help="This panel tracks the currently selected generation, including active render progress, playback and download once complete.">
        <div>{!minimal && <span className="lf-label">Your creation</span>}</div>
        <div className="lf-preview-header-actions">
          {video.objectUrl && (
            <a
              className="lf-header-download"
              href={video.objectUrl}
              download={`${mediaGeneration?.id ?? "video"}.mp4`}
              data-help="Save the completed film file to your device."
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>Download</span>
            </a>
          )}
          {headerControls}
        </div>
      </header>
      {!minimal && (
        <div className="lf-preview-tabs">
          <span data-help="Your creative brief and individual scene directions form the generation plan.">
            ϟ <b>Create</b>
            <small>Studio prompt</small>
          </span>
          <span data-help="LTX converts the planned scenes and frame anchors into moving video clips.">
            ▣ <b>Render</b>
            <small>LTX video</small>
          </span>
          <span data-help="Your generation session and resulting film remain associated with your private account.">
            ♢ <b>Privacy</b>
            <small>Private session</small>
          </span>
        </div>
      )}
      <div
        className={`lf-screen ${
          minimal
            ? `lf-screen-minimal lf-screen-${aspectRatio.replace(":", "-")}`
            : ""
        }`}
        data-help="The selected generated film appears here. While empty, this shows the Storyboard preview artwork."
      >
        {video.objectUrl ? (
          <video key={aspectRatio} src={video.objectUrl} controls />
        ) : mediaGeneration?.output?.downloadUrl ? (
          <VideoRetrievalMark />
        ) : (
          <img
            key={aspectRatio}
            src="/images/longform-ltx-storyboard-studio-film-roll.webp"
            alt="Film roll containing a sequence of cinematic storyboard frames"
          />
        )}
        {(loading || failureMessage) && (
          <div
            className={`lf-rendering ${failureMessage ? "lf-render-error" : ""}`}
            data-help={
              failureMessage
                ? "The selected generation failed. The error shown here is the safe runtime failure message."
                : "Live render feedback from the runtime."
            }
          >
            <div>
              {!failureMessage && (
                <span className="lf-render-spinner" aria-hidden="true">
                  <img src="/fav-icon.png" alt="" />
                </span>
              )}
              <strong>{failureMessage ? "Render failed" : progressLabel}</strong>
              <small>{failureMessage ?? activityLabel}</small>
              {(runtimeCounter || runtimeStage || failureCode) && (
                <b>{runtimeCounter ?? runtimeStage ?? failureCode}</b>
              )}
              {failureMessage && onAskDirectorRepair && (
                <button
                  type="button"
                  className="lf-render-repair"
                  disabled={directorBusy}
                  onClick={() => onAskDirectorRepair(failureMessage)}
                >
                  {directorBusy ? "Director is working…" : "Ask Director to fix"}
                </button>
              )}
              {!failureMessage && loading && generation && (
                <button
                  type="button"
                  className="lf-cancel lf-cancel-overlay"
                  data-help="Ask the generation service to stop the currently active storyboard render."
                  disabled={cancelling}
                  onClick={onCancel}
                >
                  <span className="lf-button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <rect
                        x="7"
                        y="7"
                        width="10"
                        height="10"
                        rx="2"
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                  <span>{cancelling ? "Cancelling…" : "Cancel active render"}</span>
                </button>
              )}
            </div>
          </div>
        )}
        {!loading && submissionError && (
          <div
            className="lf-rendering lf-render-error"
            data-help="The generation request was rejected before a new render started. Finish or cancel the active render, then submit again."
          >
            <div>
              <strong>
                {submissionError.toLowerCase().includes("paused")
                  ? "Submissions are paused"
                  : "Generation could not start"}
              </strong>
              <small>{submissionError}</small>
            </div>
          </div>
        )}
      </div>
      {!minimal && (
        <div className="lf-preview-actions">
          <button
            type="button"
            data-help="Validate the brief and scenes, then submit the complete storyboard to the video-generation queue."
            disabled={!canGenerate}
            className="lf-primary lf-generate"
            onClick={onGenerate}
          >
            <span className="lf-button-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 5.8v12.4c0 .8.9 1.3 1.6.9l9.2-6.2a1.1 1.1 0 0 0 0-1.8L9.6 4.9C8.9 4.5 8 5 8 5.8Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span>{generateLabel}</span>
          </button>
        </div>
      )}
      {cancelError && <p className="lf-error">{cancelError}</p>}
      {video.error && (
        <p className="error">Video retrieval failed: {video.error}</p>
      )}
      {!minimal && (
        <p
          className="lf-ready"
          data-help="Plain-language status for the selected generated film."
        >
          {generation
            ? `Generated video ${generation.status}`
            : "Your generated film will appear here"}
        </p>
      )}
      {!minimal && generation && (
        <div className="lf-stats lf-stats-reveal">
          <span data-help="Shows whether the selected film is waiting, rendering or complete.">
            <b>⌁ Status</b>
            {statusLabel}
          </span>
          <span data-help="Reported frame, scene or percentage progress from the runtime.">
            <b>◐ Progress</b>
            {runtimeCounter ?? visibleProgress ?? "Waiting"}
          </span>
          <span data-help="Time since this generation was submitted.">
            <b>⏱ Elapsed</b>
            {formatElapsed(generation?.createdAt, now)}
          </span>
        </div>
      )}
      {videoSettingsPanel}
      {!minimal && generation && (
        <div
          className="lf-progress"
          data-help="Approximate runtime progress indicator."
          aria-label={`${progress}% approximate render progress`}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
    </section>
  );
  if (!minimal) return panel;
  return (
    <div className="lf-preview-shell">
      <div className="lf-preview-orb" aria-hidden="true">
        <span className="lf-orb-disc" />
        <span className="lf-orbit lf-orbit-one" />
        <span className="lf-orbit lf-orbit-two" />
        <span className="lf-orbit lf-orbit-three" />
        <span className="lf-orbit-spark" />
        <span className="lf-orbit-node" />
      </div>
      {panel}
    </div>
  );
}
function History({
  generations,
  onSelect,
}: {
  generations: Generation[];
  onSelect: (generation: Generation) => void;
}) {
  const visibleGenerations = generations.slice(0, 2);
  return (
    <section className="lf-history lf-panel">
      <header data-help="Recent storyboard generations from this session. Select one to inspect it in the preview above.">
        <span>▣</span>
        <div>
          <strong>Previous generated videos</strong>
          <small>{generations.length} films in your recent gallery</small>
        </div>
        <b>Recent work</b>
      </header>
      {visibleGenerations.length > 0 ? (
        <div className="lf-history-grid">
          {visibleGenerations.map((generation) => (
            <button
              key={generation.id}
              data-help="Select this previous generation to inspect and play it in the cinematic preview."
              onClick={() => onSelect(generation)}
            >
              <GenerationThumbnail generation={generation} />
              <strong>{generation.prompt}</strong>
              <small>{generation.status}</small>
            </button>
          ))}
        </div>
      ) : (
        <div
          className="lf-history-empty"
          data-help="Completed and recent storyboard generations will be collected here for quick access."
        >
          <span>▶</span>
          <div>
            <strong>Your storyboard films will collect here</strong>
            <small>Generate the first cut to begin your history.</small>
          </div>
        </div>
      )}
      <Link
        className="lf-history-more"
        to="/gallery"
        data-help="Open the complete gallery of generated videos."
      >
        More videos <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}

function GenerationThumbnail({ generation }: { generation: Generation }) {
  const storageKey = `vl_thumbnail_${generation.id}`;
  const [thumbnail, setThumbnail] = useState(
    () => localStorage.getItem(storageKey) ?? "",
  );
  const video = useAuthenticatedVideo(
    thumbnail ? undefined : generation.output?.downloadUrl,
  );

  useEffect(() => {
    if (thumbnail || !video.objectUrl) return;
    const source = document.createElement("video");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    let cancelled = false;
    let best: { score: number; image: string } | undefined;
    let sampleIndex = 0;
    const samplePositions = [0.12, 0.28, 0.44, 0.6, 0.76, 0.9];
    canvas.width = 480;
    canvas.height = 360;
    source.src = video.objectUrl;
    source.muted = true;
    source.playsInline = true;
    source.preload = "auto";

    const finish = () => {
      if (cancelled || !best) return;
      try {
        localStorage.setItem(storageKey, best.image);
      } catch {
        /* Storage can be unavailable or full. */
      }
      setThumbnail(best.image);
    };
    const sample = () => {
      if (cancelled) return;
      const width = source.videoWidth;
      const height = source.videoHeight;
      if (!width || !height) return finish();
      const sourceRatio = width / height;
      const targetRatio = 4 / 3;
      let sx = 0;
      let sy = 0;
      let sw = width;
      let sh = height;
      if (sourceRatio > targetRatio) {
        sw = height * targetRatio;
        sx = (width - sw) / 2;
      } else {
        sh = width / targetRatio;
        sy = (height - sh) / 2;
      }
      context.drawImage(
        source,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let luminanceTotal = 0;
      let luminanceSquared = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        const luminance =
          pixels[index] * 0.2126 +
          pixels[index + 1] * 0.7152 +
          pixels[index + 2] * 0.0722;
        luminanceTotal += luminance;
        luminanceSquared += luminance * luminance;
      }
      const count = pixels.length / 16;
      const mean = luminanceTotal / count;
      const variance = Math.max(0, luminanceSquared / count - mean * mean);
      if (mean > 18 && mean < 237) {
        const score = variance + Math.min(mean, 255 - mean) * 12;
        if (!best || score > best.score)
          best = { score, image: canvas.toDataURL("image/jpeg", 0.78) };
      }
      sampleIndex += 1;
      if (sampleIndex >= samplePositions.length) finish();
      else
        source.currentTime = Math.max(
          0.01,
          source.duration * samplePositions[sampleIndex],
        );
    };
    source.addEventListener(
      "loadedmetadata",
      () => {
        source.currentTime = Math.max(
          0.01,
          source.duration * samplePositions[0],
        );
      },
      { once: true },
    );
    source.addEventListener("seeked", sample);
    source.addEventListener("error", finish, { once: true });
    return () => {
      cancelled = true;
      source.removeAttribute("src");
      source.load();
    };
  }, [generation.id, storageKey, thumbnail, video.objectUrl]);

  if (thumbnail)
    return (
      <div className="lf-history-thumbnail">
        <img src={thumbnail} alt="Video thumbnail" />
      </div>
    );
  return (
    <div className="lf-history-thumbnail placeholder">
      <span>
        {generation.status === "completed"
          ? "Preparing preview…"
          : generation.status}
      </span>
    </div>
  );
}
