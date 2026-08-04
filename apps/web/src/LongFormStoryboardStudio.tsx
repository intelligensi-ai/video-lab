import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { MAX_STORYBOARD_SCENES } from "@video-lab/contracts";
import type {
  Generation,
  StoryboardProjectSummary,
} from "@video-lab/contracts";
import {
  assembleStoryboardFilm,
  cancelGeneration,
  createStoryboardProject,
  deleteStoryboardProject,
  emptyContinuityBible,
  enhanceStoryboard,
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
  storeUserAsset,
  waitForGeneration,
  type LongFormGenerationPayload,
  type ReferenceRole,
  type StoryboardScenePayload,
  type StoryboardProjectReference,
  type StoryboardTransition,
} from "./api.js";
import {
  AuthenticatedVideo,
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

type LongFormReference = {
  label: string;
  role: ReferenceRole;
  file?: File;
  preview?: string;
  strength: number;
  helper: string;
};

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

const initialScenes: StoryboardScenePayload[] = [
  {
    id: "scene-1",
    title: "Scene 1",
    prompt: "",
    duration: 5,
    trimStart: 0,
    trimEnd: 5,
    seed: 1337,
    seedOverrideEnabled: false,
    summary: "",
    continuityOverrides: {},
    transition: "cut",
    transitionDuration: 0.75,
    carryPreviousFrame: true,
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
    soundEffects: "intent_only",
    ambience: "intent_only",
    music: "prompted_or_unambiguous_performance",
    preserveSourceAudio: false,
  },
  candidateCount: 3,
  projectReferences: [],
};

const freshInitialForm = (): LongFormGenerationPayload =>
  globalThis.structuredClone(initialForm);

function normalizePersistedForm(
  saved: LongFormGenerationPayload,
): LongFormGenerationPayload {
  return {
    ...freshInitialForm(),
    ...saved,
    audioPolicy: saved.audioPolicy ?? freshInitialForm().audioPolicy,
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

function markAcceptedClipsStale(
  form: LongFormGenerationPayload,
  staleReason: string,
): LongFormGenerationPayload {
  return {
    ...form,
    scenes: form.scenes.map((scene) =>
      scene.acceptedVideoGenerationId ? { ...scene, staleReason } : scene,
    ),
  };
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
type FrameState = {
  status: "idle" | "queued" | "generating" | "failed";
  error?: string;
};
type SceneRenderState = FrameState;

export default function LongFormStoryboardStudio() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(freshInitialForm);
  const [history, setHistory] = useState<Generation[]>([]);
  const [selected, setSelected] = useState<Generation>();
  const [helpMode, setHelpMode] = useState(false);
  const [sessionOwner, setSessionOwner] = useState("");
  const [projects, setProjects] = useState<StoryboardProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectTitle, setProjectTitle] = useState("Untitled film");
  const [projectError, setProjectError] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [undoForm, setUndoForm] = useState<LongFormGenerationPayload>();
  const [frameStates, setFrameStates] = useState<Record<string, FrameState>>(
    {},
  );
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
  const mutation = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error("Choose a project before rendering.");
      return generateLongFormVideo(form, projectId);
    },
    onSuccess: (generation) => {
      setSelected(generation);
      setHistory((items) => [generation, ...items].slice(0, 8));
    },
  });
  const assembly = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error("Choose a project before assembling.");
      return assembleStoryboardFilm(form, projectId);
    },
    onSuccess: (generation) => {
      setSelected(generation);
      setHistory((items) => [generation, ...items].slice(0, 8));
    },
  });
  const enhancement = useMutation({
    mutationFn: (action: EnhancementAction) =>
      enhanceStoryboard(form, action.targetShotNumber, projectId),
    onSuccess: (result, action) => {
      setUndoForm(form);
      setForm((current) => {
        if (action.apply === "master") {
          return markAcceptedClipsStale(
            {
              ...current,
              originalOverallGoal:
                current.originalOverallGoal ?? current.overallGoal,
              overallGoal: result.polishedMasterPrompt,
              continuityBible: result.continuityBible,
              directorAssumptions: result.assumptions,
              instructionBundle: result.instructionBundle,
            },
            "The film brief or continuity bible changed after this clip was accepted. Render this scene again before assembly.",
          );
        }
        if (action.apply === "shot" && action.targetShotNumber) {
          const enhanced = result.shots[0];
          return {
            ...current,
            scenes: current.scenes.map((scene, index) =>
              index + 1 === action.targetShotNumber
                ? {
                    ...scene,
                    title: enhanced.title,
                    narrativePurpose: enhanced.narrativePurpose,
                    prompt: enhanced.prompt,
                    firstFramePrompt: enhanced.firstFramePrompt,
                    lastFramePrompt: enhanced.lastFramePrompt,
                    continuityNotes: enhanced.continuityNotes,
                    referenceIds: enhanced.referenceIds,
                    recommendedControls: enhanced.recommendedControls,
                    audioIntent: enhanced.audioIntent,
                    candidateVariations: enhanced.candidateVariations,
                    promptOrigin: "agent",
                    staleReason:
                      scene.startFrame ||
                      scene.endFrame ||
                      scene.acceptedVideoGenerationId
                        ? "This shot prompt changed after its frame anchors were created. Review or regenerate them before rendering."
                        : scene.staleReason,
                  }
                : scene,
            ),
          };
        }
        return {
          ...current,
          originalOverallGoal:
            current.originalOverallGoal ?? current.overallGoal,
          overallGoal: result.polishedMasterPrompt,
          continuityBible: result.continuityBible,
          directorAssumptions: result.assumptions,
          instructionBundle: result.instructionBundle,
          scenes: current.scenes.map((scene, index) => {
            const enhanced = result.shots[index];
            return {
              ...scene,
              title: enhanced.title,
              narrativePurpose: enhanced.narrativePurpose,
              prompt: enhanced.prompt,
              firstFramePrompt: enhanced.firstFramePrompt,
              lastFramePrompt: enhanced.lastFramePrompt,
              continuityNotes: enhanced.continuityNotes,
              referenceIds: enhanced.referenceIds,
              recommendedControls: enhanced.recommendedControls,
              audioIntent: enhanced.audioIntent,
              candidateVariations: enhanced.candidateVariations,
              promptOrigin: "agent" as const,
              staleReason:
                scene.startFrame ||
                scene.endFrame ||
                scene.acceptedVideoGenerationId
                  ? "The enhanced direction changed after these frame anchors were created. Review or regenerate them before rendering."
                  : scene.staleReason,
            };
          }),
        };
      });
    },
  });
  useEffect(() => {
    const items = gallery.data?.items ?? [];
    setHistory(items.slice(0, 8));
    if (!selected)
      setSelected(
        items.find(
          (item) => !["completed", "failed", "cancelled"].includes(item.status),
        ),
      );
  }, [gallery.data, selected]);
  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        const owner = isProductionFirebase
          ? (await getFirebaseUser()).uid
          : localStorage.getItem("vl_token") || "demo-user";
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
          const normalized = {
            ...normalizePersistedForm(saved),
            scenes: saved.scenes?.length
              ? saved.scenes.slice(0, MAX_STORYBOARD_SCENES).map((scene) => ({
                  ...scene,
                  trimStart: 0,
                  trimEnd: scene.duration,
                  summary: scene.summary ?? "",
                  continuityOverrides: scene.continuityOverrides ?? {},
                  seedOverrideEnabled: scene.seedOverrideEnabled === true,
                }))
              : initialScenes,
            globalSeed: saved.globalSeed ?? DEFAULT_SCENE_SEED,
            seedPolicy: saved.seedPolicy ?? "global_locked",
          } satisfies LongFormGenerationPayload;
          setForm(await hydrateGeneratedFrameFiles(normalized));
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
  }, []);
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
    refetchInterval: (query) => {
      const current = query.state.data as Generation | undefined;
      return current &&
        ["completed", "failed", "cancelled"].includes(current.status)
        ? false
        : 2000;
    },
  });
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
      setSelected(cancelled);
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
        ? ({
            ...normalizePersistedForm(saved),
            scenes: saved.scenes.map((scene) => ({
              ...scene,
              summary: scene.summary ?? "",
              continuityOverrides: scene.continuityOverrides ?? {},
              seedOverrideEnabled: scene.seedOverrideEnabled === true,
            })),
          } satisfies LongFormGenerationPayload)
        : freshInitialForm();
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
    try {
      const title = `Untitled film ${projects.length + 1}`;
      const created = await createStoryboardProject(
        title,
        freshInitialForm() as unknown as Record<string, unknown>,
      );
      setProjects((items) => [created, ...items]);
      setProjectId(created.id);
      setProjectTitle(created.title);
      setForm(freshInitialForm());
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
        scene,
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
  const renderScene = async (index: number) => {
    const scene = form.scenes[index];
    if (!projectId) return;
    setSceneRenderStates((current) => ({
      ...current,
      [scene.id]: { status: "queued" },
    }));
    try {
      const successfulIds = [...(scene.candidateGenerationIds ?? [])].slice(-24);
      const variations = scene.candidateVariations ?? [];
      for (let candidateIndex = 0; candidateIndex < form.candidateCount; candidateIndex += 1) {
        const variation = variations[candidateIndex];
        const candidateScene = variation
          ? { ...scene, prompt: `${scene.prompt}\n\nControlled draft variation: ${variation}` }
          : scene;
        const submitted = await generateStoryboardScene(form, candidateScene, projectId);
        setSelected(submitted);
        setHistory((items) => [submitted, ...items].slice(0, 12));
        setSceneRenderStates((current) => ({
          ...current,
          [scene.id]: { status: "generating" },
        }));
        const completed = await waitForGeneration(submitted.id);
        if (completed.status !== "completed" || completed.output?.kind !== "video") {
          throw new Error(completed.safeErrorMessage || `Draft ${candidateIndex + 1} was not generated.`);
        }
        successfulIds.push(completed.id);
        setForm((current) => ({
          ...current,
          scenes: current.scenes.map((candidate, sceneIndex) => sceneIndex === index
            ? { ...candidate, candidateGenerationIds: [...successfulIds].slice(-24) }
            : candidate),
        }));
        setSelected(completed);
        setHistory((items) => items.map((item) => item.id === completed.id ? completed : item));
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
    updateScene(index, { acceptedVideoGenerationId: generationId, staleReason: undefined });
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
  const invalid =
    !form.overallGoal.trim() ||
    !form.scenes.length;
  const runtimeMaxScenes = Math.min(
    MAX_STORYBOARD_SCENES,
    runtime.data?.capabilities?.maxScenes ?? MAX_STORYBOARD_SCENES,
  );
  const runtimeFeatureStatus = runtime.data?.capabilities?.featureStatus ?? {};
  const allScenesAccepted =
    form.scenes.length > 0 &&
    form.scenes.every(
      (scene) => scene.acceptedVideoGenerationId && !scene.staleReason,
    );

  return (
    <main className={`lf-page ${helpMode ? "help-mode" : ""}`}>
      <header className="lf-hero">
        <div>
          <div className="lf-kickers">
            <span data-help="The generation service is connected and ready to accept a storyboard film.">
              {runtime.data?.status === "healthy"
                ? "Generator ready"
                : "Generator unavailable"}
            </span>
            <span data-help="Z-Image creates still frame anchors; LTX turns each planned scene into motion and joins the clips into one film.">
              Z-Image + LTX Storyboard
            </span>
            <span
              className={`lf-session-save ${sessionStatus}`}
              data-help="Your brief, prompts, titles, settings and uploaded frame images are automatically preserved in this browser."
            >
              {sessionStatus === "loading"
                ? "Loading session"
                : sessionStatus === "saving"
                  ? "Saving session"
                  : sessionStatus === "error"
                    ? "Session save unavailable"
                    : "Session saved"}
            </span>
            <button
              type="button"
              className="lf-help-toggle"
              aria-pressed={helpMode}
              onClick={() => setHelpMode((enabled) => !enabled)}
              data-help="Turn contextual explanations off."
            >
              {helpMode ? "✦ Help on" : "? Help"}
            </button>
          </div>
          <h1 className="editorial-page-title lf-storyboard-title">
            Storyboard Studio<span className="editorial-title-stop">.</span>
          </h1>
          <p>
            Direct a longer film scene by scene. Upload frame anchors where they
            matter; otherwise the runtime generates the opening and carries each
            real final frame into the next clip.
          </p>
        </div>
        <div className="lf-session">
          <span data-help="Shows whether the remote video-generation runtime is available.">
            {runtime.isLoading
              ? "Checking generator"
              : runtime.data?.status === "healthy"
                ? "Generator connected"
                : "Generator unavailable"}
          </span>
          <strong data-help="Storyboard sessions and generated films remain private to your signed-in account.">
            Private session
          </strong>
          <Link
            to="/gallery"
            data-help="Open all previously generated films and their details."
          >
            Gallery
          </Link>
        </div>
      </header>
      <div className="lf-layout">
        <div className="lf-controls">
          <section className="lf-panel lf-goal">
            <span className="lf-label">Creative brief</span>
            <div className="prompt-field-heading">
              <h2>Overview</h2>
              <PromptSuggestion
                value={form.overallGoal}
                suggestion="An ancient epic follows a battle-worn voyager across a mythic sea as he struggles to return to his family, while those at home defend a fragile kingdom and their faith in his survival."
                expansion="Expand this into a coherent film brief with a clear narrative progression, consistent characters and locations, a defined visual palette, lighting and lens language, material detail, emotional tone and continuity rules for every scene."
                kind="film-brief"
                onUse={(suggestion) =>
                  setForm((current) =>
                    markAcceptedClipsStale(
                      { ...current, overallGoal: suggestion },
                      "The film brief changed after this clip was accepted. Render this scene again before assembly.",
                    ),
                  )
                }
              />
            </div>
            <div
              className="lf-help-target"
              data-help="The master brief for the entire film: story progression, recurring characters, locations, palette, lens language and continuity rules."
            >
              <textarea
                aria-label="Overall artistic goal"
                value={form.overallGoal}
                placeholder="Describe the story, subject, visual language and continuity for the whole film…"
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
              Set the visual and narrative rules for the whole film. Each scene
              then contributes one clear action and camera beat.
            </p>
            <div
              className="lf-enhancer-actions"
              aria-label="Local Gemma prompt assistance"
            >
              <button
                type="button"
                className="lf-outline"
                disabled={!form.overallGoal.trim() || enhancement.isPending}
                onClick={() => enhancement.mutate({ apply: "master" })}
              >
                Polish brief
              </button>
              <button
                type="button"
                className="lf-primary"
                disabled={!form.overallGoal.trim() || enhancement.isPending}
                onClick={() => enhancement.mutate({ apply: "all" })}
              >
                {enhancement.isPending
                  ? "Gemma is preparing the storyboard…"
                  : `Enhance and plan ${form.scenes.length} shot${form.scenes.length === 1 ? "" : "s"}`}
              </button>
              <button
                type="button"
                className="lf-outline"
                onClick={() => setProjectDialogOpen(true)}
              >
                New project
              </button>
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
            <small className="lf-agent-note">
              Suggestions come from the local Gemma enhancer and stay editable.
              You can ignore them and use your own prompts.
            </small>
            {enhancement.error && (
              <p className="lf-error" role="alert">
                {enhancement.error.message}
              </p>
            )}
          </section>
          <ProjectReferencePanel
            references={form.projectReferences}
            sceneIds={form.scenes.map((scene) => scene.id)}
            onChange={(projectReferences) => setForm((current) => ({ ...current, projectReferences }))}
          />
          <section className="lf-scenes">
            <div className="lf-section-head">
              <div>
                <span className="lf-label">Timeline</span>
                <h2>Storyboard scenes</h2>
              </div>
              <button
                type="button"
                className="lf-primary lf-add"
                data-help="Append a new editable scene card up to the active LongForm runtime limit."
                disabled={form.scenes.length >= runtimeMaxScenes}
                onClick={addScene}
              >
                ＋ Add scene
              </button>
            </div>
            {form.scenes.map((scene, index) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                index={index}
                count={form.scenes.length}
                onChange={(patch) => updateScene(index, patch)}
                onMove={(direction) => moveScene(index, direction)}
                onRemove={() => removeScene(index)}
                frameState={{
                  start: frameStates[`${scene.id}:start`] ?? { status: "idle" },
                  end: frameStates[`${scene.id}:end`] ?? { status: "idle" },
                }}
                onGenerateFrame={(edge) => void regenerateFrame(index, edge)}
                onRegeneratePrompt={() =>
                  enhancement.mutate({
                    apply: "shot",
                    targetShotNumber: index + 1,
                  })
                }
                promptBusy={enhancement.isPending}
                renderState={sceneRenderStates[scene.id] ?? { status: "idle" }}
                onRender={() => void renderScene(index)}
                onAcceptCandidate={(generationId) => acceptSceneCandidate(index, generationId)}
                globalSeed={form.globalSeed}
                seedPolicy={form.seedPolicy}
              />
            ))}
          </section>
        </div>
        <aside className="lf-preview-col">
          <section className="lf-panel lf-storyboard-settings">
            <span className="lf-label">Setup</span>
            <h2>Storyboard settings</h2>
            <div className="lf-settings">
              <Field
                label="Sound behaviour"
                help="Only when requested is conservative: mood words never add music, while quoted dialogue and explicit sound markers can enable sound."
              >
                <select
                  value={form.audioPolicy.mode}
                  onChange={(event) => {
                    const mode = event.target.value as LongFormGenerationPayload["audioPolicy"]["mode"];
                    setForm((current) => markAcceptedClipsStale({
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
                    }, "The sound policy changed after this clip was accepted. Render it again before assembly."));
                  }}
                >
                  <option value="silent">Silent</option>
                  <option value="intent_only">Only when requested</option>
                  <option value="directed">Directed sound</option>
                </select>
              </Field>
              <NumberField
                label="Drafts per scene"
                help="Drafts run sequentially so one creator cannot monopolise the shared generation pool."
                value={form.candidateCount}
                min={1}
                max={4}
                step={1}
                onChange={(candidateCount) => setForm((current) => ({
                  ...current,
                  candidateCount: Math.min(4, Math.max(1, Math.round(candidateCount))),
                }))}
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
                <summary>Direct dialogue, ambience, effects and music</summary>
                <div className="lf-settings">
                  {([
                    ["dialogue", "Dialogue", ["off", "prompted_only", "on"]],
                    ["soundEffects", "Sound effects", ["off", "intent_only", "on"]],
                    ["ambience", "Ambience", ["off", "intent_only", "on"]],
                    ["music", "Music", ["off", "prompted_or_unambiguous_performance", "on"]],
                  ] as const).map(([key, label, options]) => (
                    <Field key={key} label={label}>
                      <select
                        value={form.audioPolicy[key]}
                        onChange={(event) => setForm((current) => ({
                          ...current,
                          audioPolicy: { ...current.audioPolicy, [key]: event.target.value },
                        }))}
                      >
                        {options.map((option) => (
                          <option key={option} value={option}>{option.replaceAll("_", " ")}</option>
                        ))}
                      </select>
                    </Field>
                  ))}
                  <label className="lf-toggle">
                    <input
                      type="checkbox"
                      checked={form.audioPolicy.preserveSourceAudio}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        audioPolicy: { ...current.audioPolicy, preserveSourceAudio: event.target.checked },
                      }))}
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
          <section
            className="lf-panel lf-assembly"
            aria-label="Accepted scene assembly"
          >
            <span className="lf-label">Finishing</span>
            <h2>Assemble accepted clips</h2>
            <p>
              Render and accept one clip per scene, then join only those clips.
              Assembly preserves the full accepted clips and transitions without rerunning LTX.
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
              disabled={!allScenesAccepted || assembly.isPending || isRendering}
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
              LongForm worker does not yet condition LTX directly on character,
              style or voice media. Per-scene first and last frames remain the
              verified visual controls.
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
                <Field
                  label="Finishing pass"
                  help="These are delivery transforms after you accept the creative draft. They use FFmpeg and cannot repair identity drift, weak motion or composition."
                >
                  <select
                    value={form.postProcess}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        postProcess: event.target.value,
                      }))
                    }
                  >
                    <option value="none">Draft â€” no delivery transform</option>
                    <option value="interpolate">Review â€” smooth motion</option>
                    <option value="upscale">Final â€” delivery upscale</option>
                    <option value="both">Final â€” smooth + upscale</option>
                  </select>
                </Field>
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
                  <span className="lf-label">Shared negative prompt</span>
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
                  Start/end frames: {runtimeFeatureStatus.startFrame ?? "supported"}; draft version stacks: {runtimeFeatureStatus.candidates ?? "client_managed"}; technical quality checks: {runtimeFeatureStatus.qualityAssessment ?? "partial"}.
                </p>
                <p>
                  Retake, extend, generative reframe, video modification, identity-reference conditioning and HDR remain unavailable until their runtime workflows produce acceptance evidence.
                </p>
              </div>
            </div>
          </details>
          <Preview
            generation={currentGeneration}
            loading={isRendering}
            submissionError={mutation.error?.message}
            canGenerate={!invalid && !mutation.isPending}
            generateLabel={
              mutation.isPending
                ? "◌ Rendering storyboard..."
                : "Generate complete film in one run"
            }
            onGenerate={() => mutation.mutate()}
            cancelling={cancellation.isPending}
            onCancel={() => cancellation.mutate()}
            cancelError={cancellation.error?.message}
          />
          <History generations={history} onSelect={setSelected} />
        </aside>
      </div>
      {projectDialogOpen && (
        <div
          className="lf-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProjectDialogOpen(false);
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
  onChange,
}: {
  references: StoryboardProjectReference[];
  sceneIds: string[];
  onChange: (references: StoryboardProjectReference[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<StoryboardProjectReference["type"]>("character");
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
      onChange([...references, {
        id: crypto.randomUUID(),
        type,
        label: label.trim(),
        description: description.trim(),
        lockedTraits: traits.split(",").map((trait) => trait.trim()).filter(Boolean).slice(0, 24),
        sceneIds: [],
        ...(assetId ? { assetId } : {}),
        assetVersionIds: assetId ? [assetId] : [],
        version: 1,
      }]);
      setLabel("");
      setDescription("");
      setTraits("");
      setFile(undefined);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The private reference could not be added.");
    } finally {
      setBusy(false);
    }
  };
  const updateReference = (id: string, patch: Partial<StoryboardProjectReference>) =>
    onChange(references.map((reference) => reference.id === id ? { ...reference, ...patch } : reference));
  const replaceFile = async (reference: StoryboardProjectReference, replacement?: File) => {
    if (!replacement) return;
    setBusy(true);
    setError("");
    try {
      const assetId = await storeUserAsset(replacement, "projectReference");
      if (assetId) updateReference(reference.id, {
        assetId,
        assetVersionIds: [...reference.assetVersionIds, assetId].slice(-24),
        version: reference.version + 1,
      });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The private reference could not be replaced.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lf-reference-panel">
      <button type="button" className="lf-reference-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="lf-reference-icon">â–§</span>
        <span><strong>Project references</strong><small>Characters, places, products, style and voice direction Â· {references.length} saved</small></span>
        <b>{open ? "âŒƒ" : "âŒ„"}</b>
      </button>
      {open && (
        <div className="lf-project-references">
          <p className="lf-capability-note">
            Gemma uses these private descriptions as continuity locks. The current LTX workflow supports actual start/end frame conditioning; other reference media remain planning-only until runtime capability evidence is available.
          </p>
          <div className="lf-reference-create">
            <Field label="Reference type">
              <select value={type} onChange={(event) => setType(event.target.value as StoryboardProjectReference["type"])}>
                {(["character", "location", "product", "style", "voice", "motion"] as const).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </Field>
            <Field label="Friendly name"><input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} /></Field>
            <Field label="How to use it"><textarea value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} /></Field>
            <Field label="Locked traits" help="Comma-separated details that should not drift."><input value={traits} onChange={(event) => setTraits(event.target.value)} /></Field>
            <Field label="Optional private image">
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0])} />
            </Field>
            <button type="button" className="lf-outline" disabled={busy || !label.trim()} onClick={() => void addReference()}>{busy ? "Savingâ€¦" : "Add reference"}</button>
          </div>
          {error && <p className="lf-error" role="alert">{error}</p>}
          <div className="lf-reference-grid">
            {references.map((reference) => (
              <article key={reference.id} className="lf-reference-card has-file">
                <ProjectReferencePreview reference={reference} />
                <strong>{reference.label}</strong>
                <small>{reference.type} Â· version {reference.version}</small>
                {reference.assetVersionIds.length > 1 && (
                  <select
                    aria-label={`${reference.label} media version`}
                    value={reference.assetId}
                    onChange={(event) => updateReference(reference.id, {
                      assetId: event.target.value,
                      version: reference.assetVersionIds.indexOf(event.target.value) + 1,
                    })}
                  >
                    {reference.assetVersionIds.map((assetId, versionIndex) => (
                      <option key={assetId} value={assetId}>Media version {versionIndex + 1}</option>
                    ))}
                  </select>
                )}
                <textarea value={reference.description} aria-label={`${reference.label} usage`} onChange={(event) => updateReference(reference.id, { description: event.target.value })} />
                <input value={reference.lockedTraits.join(", ")} aria-label={`${reference.label} locked traits`} onChange={(event) => updateReference(reference.id, { lockedTraits: event.target.value.split(",").map((trait) => trait.trim()).filter(Boolean).slice(0, 24) })} />
                <details>
                  <summary>Assign to scenes</summary>
                  {sceneIds.map((sceneId, sceneIndex) => (
                    <label key={sceneId} className="lf-toggle">
                      <input type="checkbox" checked={reference.sceneIds.includes(sceneId)} onChange={(event) => updateReference(reference.id, { sceneIds: event.target.checked ? [...reference.sceneIds, sceneId] : reference.sceneIds.filter((id) => id !== sceneId) })} />
                      <span /> Scene {sceneIndex + 1}
                    </label>
                  ))}
                  <small>No selected scenes means the reference applies project-wide.</small>
                </details>
                <label className="lf-outline">Replace image<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void replaceFile(reference, event.target.files?.[0])} /></label>
                <button type="button" onClick={() => onChange(references.filter((item) => item.id !== reference.id))}>Remove from project</button>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectReferencePreview({ reference }: { reference: StoryboardProjectReference }) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (!reference.assetId) {
      setPreview("");
      return;
    }
    void fetchUserAsset(reference.assetId).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview(objectUrl);
    }).catch(() => setPreview(""));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reference.assetId]);
  return preview ? <img src={preview} alt={`${reference.label} private reference`} /> : <div className="lf-reference-preview">No media preview</div>;
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
  index,
  count,
  onChange,
  onMove,
  onRemove,
  frameState,
  onGenerateFrame,
  onRegeneratePrompt,
  promptBusy,
  renderState,
  onRender,
  onAcceptCandidate,
  globalSeed,
  seedPolicy,
}: {
  scene: StoryboardScenePayload;
  index: number;
  count: number;
  onChange: (patch: Partial<StoryboardScenePayload>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  frameState: { start: FrameState; end: FrameState };
  onGenerateFrame: (edge: "start" | "end") => void;
  onRegeneratePrompt: () => void;
  promptBusy: boolean;
  renderState: SceneRenderState;
  onRender: () => void;
  onAcceptCandidate: (generationId: string) => void;
  globalSeed: number;
  seedPolicy: LongFormGenerationPayload["seedPolicy"];
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(index === 0);
  const selectedTransition =
    transitionOptions.find((option) => option.value === scene.transition) ??
    transitionOptions[0];
  const suggestion =
    index === 0
      ? "Wide street-level tracking shot. The founder notices a thin teal reflection moving through puddles. Keep the face and trench coat consistent; slow handheld pursuit; cool rain and warm shop windows."
      : "Begin from the previous final frame. The signal climbs a bridge rail as the camera arcs around the founder, revealing the skyline. Preserve direction of travel, identity, wet materials and the restrained teal-and-amber palette.";
  return (
    <article className={expanded ? "lf-scene" : "lf-scene collapsed"}>
      <header>
        <button
          type="button"
          className="lf-scene-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} scene ${index + 1}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="lf-scene-number">{index + 1}</span>
        </button>
        <span
          className="lf-help-target lf-scene-title-help"
          data-help="A short editorial name used to identify this scene in the timeline."
        >
          <input
            aria-label={`Scene ${index + 1} title`}
            value={scene.title}
            onChange={(event) =>
              onChange({
                title: event.target.value,
                staleReason: scene.acceptedVideoGenerationId
                  ? "The scene title changed after its accepted clip was rendered. Render this scene again before assembly."
                  : scene.staleReason,
              })
            }
          />
        </span>
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
          onUse={(value) => onChange({ prompt: value, promptOrigin: "agent" })}
        />
        <button
          type="button"
          className="lf-regenerate-shot"
          disabled={promptBusy}
          onClick={onRegeneratePrompt}
        >
          Regenerate this shot
        </button>
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
      </header>
      {expanded ? (
        <>
      <div
        className="prompt-field scene-prompt-field"
        data-help="Describe one story beat: subject action, camera movement, lighting change and the final frame that leads into the following scene."
      >
        <div className="prompt-field-heading">
          <span className="lf-label">Scene direction</span>
          <small>
            {scene.promptOrigin === "agent"
              ? "Gemma suggestion"
              : "Your direction"}
          </small>
        </div>
        <textarea
          aria-label={`Scene ${index + 1} direction`}
          value={scene.prompt}
          placeholder="Describe one clear action, camera movement, lighting beat and final composition…"
          onChange={(event) =>
            onChange({
              prompt: event.target.value,
              promptOrigin: "user",
              staleReason:
                scene.startFrame ||
                scene.endFrame ||
                scene.acceptedVideoGenerationId
                  ? "This direction changed after its frame anchors were created. Review or regenerate them before rendering."
                  : scene.staleReason,
            })
          }
        />
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
      </div>
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
            onChange={(seed) => onChange({ seed, seedOverrideEnabled: true })}
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
          />
        </div>
      </details>
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
      {scene.staleReason && (
        <p className="lf-stale-note" role="status">
          {scene.staleReason}
        </p>
      )}
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
            Draft candidates render one at a time for queue fairness. Previous
            versions and the accepted clip remain available.
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
              ? "Rendering scene…"
              : scene.candidateGenerationIds?.length
                ? "Generate more drafts"
                : "Generate draft candidates"}
        </button>
      </div>
      {renderState.status === "failed" && (
        <p className="lf-error" role="alert">
          {renderState.error} The previous accepted clip is unchanged.
        </p>
      )}
      {scene.acceptedVideoGenerationId && (
        <SceneAcceptedVideo generationId={scene.acceptedVideoGenerationId} />
      )}
      {!!scene.candidateGenerationIds?.length && (
        <SceneCandidateStack
          sceneNumber={index + 1}
          generationIds={scene.candidateGenerationIds}
          acceptedGenerationId={scene.acceptedVideoGenerationId}
          onAccept={onAcceptCandidate}
        />
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
          {scene.prompt.trim() || "Open this scene to add direction, timing and render controls."}
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
}: {
  edge: "start" | "end";
  file?: File;
  prompt: string;
  state: FrameState;
  onPrompt: (value: string) => void;
  onFile: (file?: File) => void;
  onGenerate: () => void;
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
        <p className="lf-error" role="alert">
          {state.error} Your previous frame is unchanged. Retry when ready.
        </p>
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
    <div className="lf-candidate-stack" aria-label={`Scene ${sceneNumber} draft candidates`}>
      <strong>Draft version stack</strong>
      <small>Ranked by advisory technical checks; your creative choice remains authoritative.</small>
      <div className="lf-candidate-grid">
        {ranked.map((candidate, rankIndex) => (
          <SceneCandidateVideo
            key={candidate.generationId}
            generationId={candidate.generationId}
            label={`Draft ${candidate.originalIndex + 1}`}
            rank={candidate.generation?.qualityAssessment ? rankIndex + 1 : undefined}
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
    return <article className="lf-candidate-card">Loading {label.toLowerCase()}â€¦</article>;
  if (generation.data?.status !== "completed" || !generation.data.output?.downloadUrl) {
    return (
      <article className="lf-candidate-card">
        <strong>{label}</strong>
        <p className="lf-error">This draft is unavailable.</p>
      </article>
    );
  }
  const quality = generation.data.qualityAssessment;
  const issues = quality?.checks.filter((check) => check.status === "failed" || check.status === "warning") ?? [];
  return (
    <article className={accepted ? "lf-candidate-card accepted" : "lf-candidate-card"}>
      <header>
        <strong>{label}</strong>
        <span>{accepted ? "Accepted" : rank ? `Rank ${rank}` : "Review"}</span>
      </header>
      <AuthenticatedVideo downloadUrl={generation.data.output.downloadUrl} />
      {quality && (
        <small>
          Quality score {quality.score}/100. Automated checks are advisory. {issues.length
            ? `${issues.length} issue${issues.length === 1 ? "" : "s"} need review.`
            : "No media-integrity issues were reported."}
        </small>
      )}
      <button type="button" className="lf-outline" disabled={accepted} onClick={onAccept}>
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
          <img src={preview} alt={`${label} preview`} />
        ) : (
          <span aria-hidden="true">▧</span>
        )}
        <span className="lf-upload-copy">
          <strong>{label}</strong>
          <small>
            {file?.name ?? "Drag and drop an image, or click to browse"}
          </small>
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
  loading,
  submissionError,
  canGenerate,
  generateLabel,
  onGenerate,
  cancelling,
  onCancel,
  cancelError,
}: {
  generation?: Generation;
  loading: boolean;
  submissionError?: string;
  canGenerate: boolean;
  generateLabel: string;
  onGenerate: () => void;
  cancelling: boolean;
  onCancel: () => void;
  cancelError?: string;
}) {
  const video = useAuthenticatedVideo(generation?.output?.downloadUrl);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);
  const progress = clampProgress(generation?.progress, generation?.status);
  const statusLabel = generation?.status
    ? generation.status.replace("_", " ")
    : "Ready";
  const progressLabel =
    generation?.status === "completed"
      ? "Render complete"
      : generation?.status === "queued"
        ? "Assembling movie"
        : generation?.status === "preparing"
          ? "Preparing render"
          : generation?.status === "generating"
            ? "Rendering with runtime"
            : generation?.status === "uploading"
              ? "Finalising output"
              : loading
                ? "Rendering with runtime"
                : "Ready";
  const queueLabel =
    generation?.queuePosition && generation.queuePosition > 1
    ? `Queue position ${generation.queuePosition}`
    : "Setting up the render pipeline";
  const activityLabel =
    generation?.runtimeMessage ||
    (generation?.status === "queued"
      ? queueLabel
      : `${statusLabel} with runtime`);
  const runtimeCounter = runtimeProgressCounter(generation);

  return (
    <section className="lf-preview lf-panel">
      <header data-help="This panel tracks the currently selected generation, including active render progress, playback and download once complete.">
        <div>
          <span className="lf-label">Your creation</span>
          <h2>Cinematic preview</h2>
          <p>Intelligensi.ai Storyboard Studio</p>
        </div>
        <span
          className="lf-complete"
          data-help="The current state of the selected generation: ready, queued, rendering, completed, failed or cancelled."
        >
          {loading
            ? "Rendering"
            : submissionError
              ? "Action needed"
              : statusLabel}
        </span>
      </header>
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
      <div
        className="lf-screen"
        data-help="The selected generated film appears here. While empty, this shows the Storyboard preview artwork."
      >
        {video.objectUrl ? (
          <video src={video.objectUrl} controls />
        ) : generation?.output?.downloadUrl ? (
          <div className="thumb big">Retrieving completed video…</div>
        ) : (
          <img
            src="/images/longform-ltx-storyboard-studio-film-roll.webp"
            alt="Film roll containing a sequence of cinematic storyboard frames"
          />
        )}
        {loading && (
          <div
            className="lf-rendering"
            data-help="Live render feedback from the runtime."
          >
            <div>
              <span className="lf-render-spinner" aria-hidden="true">
                <img src="/fav-icon.png" alt="" />
              </span>
              <strong>{progressLabel}</strong>
              <small>{activityLabel}</small>
              {runtimeCounter && <b>{runtimeCounter}</b>}
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
      <div className="lf-preview-actions">
        <button
          type="button"
          data-help="Validate the brief and scenes, then submit the complete storyboard to the video-generation queue."
          disabled={!canGenerate}
          className="lf-primary lf-generate"
          onClick={onGenerate}
        >
          {generateLabel}
        </button>
        {loading && generation && (
          <button
            type="button"
            className="lf-cancel"
            data-help="Ask the generation service to stop the currently active storyboard render."
            disabled={cancelling}
            onClick={onCancel}
          >
            {cancelling ? "Cancelling…" : "Cancel active render"}
          </button>
        )}
      </div>
      {cancelError && <p className="lf-error">{cancelError}</p>}
      {video.error && (
        <p className="error">Video retrieval failed: {video.error}</p>
      )}
      {video.objectUrl && (
        <a
          className="lf-download"
          data-help="Save the completed film file to your device."
          href={video.objectUrl}
          download={`${generation?.id ?? "video"}.mp4`}
        >
          ⇩ Download video
        </a>
      )}
      <p
        className="lf-ready"
        data-help="Plain-language status for the selected generated film."
      >
        {generation
          ? `Generated video ${generation.status}`
          : "Your generated film will appear here"}
      </p>
      <div className="lf-stats">
        <span data-help="Shows whether the selected film is waiting, rendering or complete.">
          <b>⌁ Status</b>
          {generation ? statusLabel : "—"}
        </span>
        <span data-help="Real frame or scene progress reported by the runtime when available.">
          <b>▥ Runtime</b>
          {runtimeCounter ?? "—"}
        </span>
        <span data-help="Time since this generation was submitted.">
          <b>◷ Elapsed</b>
          {formatElapsed(generation?.createdAt, now)}
        </span>
      </div>
      <div
        className="lf-progress"
        data-help="Approximate runtime progress indicator."
        aria-label={`${progress}% approximate render progress`}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </section>
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
