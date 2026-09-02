import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultGeneratedTextPolicy } from "@video-lab/contracts";
import type {
  DirectorActionType,
  DirectorProposal,
  Generation,
  LongFormVideoModel,
  RuntimeStatus,
  StoryboardAudioPolicy,
  StoryboardProjectSummary,
} from "@video-lab/contracts";
import {
  acceptDirectorProposal,
  assembleStoryboardFilm,
  cancelGeneration,
  createDirectorProposal,
  createStoryboardProject,
  deleteStoryboardProject,
  discardDirectorProposal,
  emptyContinuityBible,
  fetchGenerationOutput,
  generateStoryboardFrame,
  generateStoryboardScene,
  getGeneration,
  getRuntimeStatus,
  listDirectorProposals,
  listStoryboardProjects,
  MAX_INTERMEDIATE_KEYFRAMES,
  resumePendingDirectorProposal,
  storeUserAsset,
  storyboardAsyncProgressMessage,
  waitForGeneration,
  type LongFormGenerationPayload,
  type StoryboardProjectReference,
  type StoryboardScenePayload,
} from "./api.js";
import { getFirebaseUser, isProductionFirebase } from "./auth.js";
import {
  deleteStoryboardSession,
  loadStoryboardSession,
  saveStoryboardSession,
} from "./storyboardSession.js";
import {
  defaultLongFormVideoModelForRuntime,
  longFormVideoModelAvailable,
  longFormProjectHasRenderedVideo,
  prepareLongFormVideoModelSwitch,
} from "./longFormVideoModels.js";

export type WorkspaceFrameState = {
  status: "idle" | "queued" | "generating" | "failed";
  error?: string;
};

export type DirectorMessage = {
  id: string;
  from: "user" | "director";
  text: string;
  proposal?: DirectorProposal;
};

const DEFAULT_AUDIO: StoryboardAudioPolicy = {
  mode: "intent_only",
  dialogue: "prompted_only",
  soundEffects: "intent_only",
  ambience: "intent_only",
  music: "prompted_or_unambiguous_performance",
  preserveSourceAudio: false,
};

function newScene(index: number, globalSeed = 1337): StoryboardScenePayload {
  return {
    id: crypto.randomUUID(),
    title: `Scene ${index + 1}`,
    prompt: "",
    duration: 5,
    trimStart: 0,
    trimEnd: 5,
    seed: globalSeed + index,
    seedOverrideEnabled: false,
    summary: "",
    continuityOverrides: {},
    transition: index === 0 ? "cut" : "crossfade",
    transitionDuration: 0.75,
    carryPreviousFrame: index > 0,
  };
}

export function freshDirectorForm(): LongFormGenerationPayload {
  return {
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
    globalSeed: 1337,
    seedPolicy: "global_locked",
    globalVisualAnchorEnabled: false,
    scenes: [newScene(0), newScene(1)],
    continuityBible: emptyContinuityBible(),
    audioPolicy: DEFAULT_AUDIO,
    generatedTextPolicy: defaultGeneratedTextPolicy(),
    candidateCount: 3,
    projectReferences: [],
    videoModel: "ltx-2.3",
  };
}

function normalizeForm(value: LongFormGenerationPayload): LongFormGenerationPayload {
  const fallback = freshDirectorForm();
  return {
    ...fallback,
    ...value,
    videoModel: value.videoModel === "ltx-2.5" ? "ltx-2.5" : "ltx-2.3",
    audioPolicy: value.audioPolicy ?? DEFAULT_AUDIO,
    candidateCount: Math.min(4, Math.max(1, value.candidateCount ?? 3)),
    continuityBible: value.continuityBible ?? fallback.continuityBible,
    projectReferences: (value.projectReferences ?? []).map((reference) => ({
      ...reference,
      assetVersionIds: reference.assetVersionIds?.length
        ? [...new Set(reference.assetVersionIds)]
        : reference.assetId
          ? [reference.assetId]
          : [],
      lockedTraits: reference.lockedTraits ?? [],
      sceneIds: reference.sceneIds ?? [],
      version: reference.version ?? 1,
    })),
    scenes: value.scenes?.length
      ? value.scenes.map((scene, index) => ({
          ...newScene(index, value.globalSeed ?? fallback.globalSeed),
          ...scene,
          trimStart: scene.trimStart ?? 0,
          trimEnd: scene.trimEnd ?? scene.duration,
          seedOverrideEnabled: scene.seedOverrideEnabled === true,
          summary: scene.summary ?? "",
          continuityOverrides: scene.continuityOverrides ?? {},
          keyframes: scene.keyframes ?? [],
        }))
      : fallback.scenes,
  };
}

async function hydrateFrames(form: LongFormGenerationPayload) {
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
            generation.output?.kind !== "frame" ||
            !generation.output.downloadUrl
          )
            return undefined;
          const blob = await fetchGenerationOutput(generation.output.downloadUrl);
          if (!blob.type.startsWith("image/")) return undefined;
          const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
          return new File([blob], `${scene.id}-${edge}.${extension}`, { type: blob.type });
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

function mergeServerForm(
  current: LongFormGenerationPayload,
  remote: Record<string, unknown>,
) {
  const normalized = normalizeForm(remote as unknown as LongFormGenerationPayload);
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
              frame: local.keyframes?.find((candidate) => candidate.id === keyframe.id)?.frame,
            })),
          }
        : scene;
    }),
  };
}

function terminal(generation?: Generation) {
  return Boolean(
    generation && ["completed", "failed", "cancelled"].includes(generation.status),
  );
}

export function useDirectorWorkspace() {
  const [form, setForm] = useState<LongFormGenerationPayload>(freshDirectorForm);
  const [projects, setProjects] = useState<StoryboardProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectTitle, setProjectTitle] = useState("Untitled film");
  const [ownerId, setOwnerId] = useState("");
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<"loading" | "saving" | "saved" | "error">("loading");
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  const [runtimeError, setRuntimeError] = useState("");
  const [frameStates, setFrameStates] = useState<Record<string, WorkspaceFrameState>>({});
  const [sceneStates, setSceneStates] = useState<Record<string, WorkspaceFrameState>>({});
  const [activeGeneration, setActiveGeneration] = useState<Generation>();
  const [proposals, setProposals] = useState<DirectorProposal[]>([]);
  const [currentProposal, setCurrentProposal] = useState<DirectorProposal>();
  const [directorBusy, setDirectorBusy] = useState(false);
  const [notice, setNotice] = useState("Loading your private project…");
  const [undoForm, setUndoForm] = useState<LongFormGenerationPayload>();
  const [lastAction, setLastAction] = useState<DirectorActionType>();
  const [messages, setMessages] = useState<DirectorMessage[]>([
    {
      id: "welcome",
      from: "director",
      text: "Tell me what you want to change or create. I will prepare a reviewable proposal and leave generation, ownership and runtime decisions to Video Lab.",
    },
  ]);
  const formRef = useRef(form);
  const projectTitleRef = useRef(projectTitle);
  const resumedDirectorJobRef = useRef("");

  useEffect(() => {
    formRef.current = form;
  }, [form]);
  useEffect(() => {
    projectTitleRef.current = projectTitle;
  }, [projectTitle]);
  useEffect(() => {
    if (!runtime?.capabilities) return;
    const currentModel = form.videoModel ?? "ltx-2.3";
    if (longFormVideoModelAvailable(runtime, currentModel)) return;
    const nextModel = defaultLongFormVideoModelForRuntime(runtime);
    if (currentModel === nextModel) return;
    setForm((current) => prepareLongFormVideoModelSwitch(current, nextModel));
    setNotice(`The active runtime uses ${nextModel === "ltx-2.5" ? "LTX 2.5 Preview" : "LTX 2.3"}; this project was updated to match.`);
  }, [form.videoModel, runtime]);

  const refreshRuntime = useCallback(async () => {
    try {
      const status = await getRuntimeStatus();
      setRuntime(status);
      setRuntimeError("");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "The generator status is unavailable.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        const owner = isProductionFirebase ? (await getFirebaseUser()).uid : "demo-user";
        let available = (await listStoryboardProjects()).items;
        if (!available.length) {
          const created = await createStoryboardProject("Untitled film", freshDirectorForm() as unknown as Record<string, unknown>);
          available = [created];
        }
        const project = available[0];
        const saved = await loadStoryboardSession(owner, project.id);
        const restored = await hydrateFrames(normalizeForm(saved ?? freshDirectorForm()));
        if (!active) return;
        setOwnerId(owner);
        setProjects(available);
        setProjectId(project.id);
        setProjectTitle(project.title);
        setForm(restored);
        setReady(true);
        setSaveState("saved");
        setNotice("Production project connected. No model generation is running.");
      } catch (error) {
        if (!active) return;
        setReady(true);
        setSaveState("error");
        setNotice(error instanceof Error ? error.message : "The private project could not be restored.");
      }
    };
    void restore();
    void refreshRuntime();
    const runtimeTimer = window.setInterval(() => void refreshRuntime(), 15_000);
    return () => {
      active = false;
      window.clearInterval(runtimeTimer);
    };
  }, [refreshRuntime]);

  useEffect(() => {
    if (!ready || !ownerId || !projectId) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      void saveStoryboardSession(ownerId, projectId, projectTitle, form)
        .then(() => {
          setSaveState("saved");
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
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          );
        })
        .catch(() => setSaveState("error"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [form, ownerId, projectId, projectTitle, ready]);

  useEffect(() => {
    if (!projectId) return;
    void listDirectorProposals(projectId)
      .then((result) => setProposals(result.items))
      .catch(() => setProposals([]));
  }, [projectId]);

  useEffect(() => {
    if (!activeGeneration || terminal(activeGeneration)) return;
    const timer = window.setInterval(() => {
      void getGeneration(activeGeneration.id)
        .then((generation) => setActiveGeneration(generation))
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : "";
          if (!/unauthori[sz]ed|forbidden|401|403/i.test(errorMessage)) return;
          setActiveGeneration((current) => current && !terminal(current)
            ? {
                ...current,
                status: "failed",
                safeErrorMessage: "Render status could not be refreshed through the authenticated backend. Retry the render from the current project.",
                updatedAt: new Date().toISOString(),
              }
            : current);
        });
    }, 2_000);
    const updatedAt = Date.parse(activeGeneration.updatedAt);
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt > 20 * 60_000) {
      setActiveGeneration({
        ...activeGeneration,
        status: "failed",
        safeErrorMessage: "This render did not report progress for too long and was cleared from the active preview. Retry the render from the current project.",
        updatedAt: new Date().toISOString(),
      });
    }
    return () => window.clearInterval(timer);
  }, [activeGeneration]);

  const updateScene = useCallback((sceneId: string, patch: Partial<StoryboardScenePayload>) => {
    setForm((current) => ({
      ...current,
      scenes: current.scenes.map((scene) =>
        scene.id === sceneId ? { ...scene, ...patch } : scene,
      ),
    }));
  }, []);

  const openProject = useCallback(
    async (nextProjectId: string) => {
      if (!ownerId || nextProjectId === projectId) return;
      const summary = projects.find((project) => project.id === nextProjectId);
      if (!summary) return;
      setReady(false);
      setSaveState("loading");
      try {
        const saved = await loadStoryboardSession(ownerId, nextProjectId);
        setForm(await hydrateFrames(normalizeForm(saved ?? freshDirectorForm())));
        setProjectId(nextProjectId);
        setProjectTitle(summary.title);
        setCurrentProposal(undefined);
        setUndoForm(undefined);
        setReady(true);
        setSaveState("saved");
        setNotice(`Opened ${summary.title}.`);
      } catch (error) {
        setReady(true);
        setSaveState("error");
        setNotice(error instanceof Error ? error.message : "Project could not be opened.");
      }
    },
    [ownerId, projectId, projects],
  );

  const createProject = useCallback(async () => {
    const title = `Untitled film ${projects.length + 1}`;
    const created = await createStoryboardProject(title, freshDirectorForm() as unknown as Record<string, unknown>);
    setProjects((items) => [created, ...items]);
    setProjectId(created.id);
    setProjectTitle(created.title);
    setForm(freshDirectorForm());
    setCurrentProposal(undefined);
    setNotice("New private project created.");
  }, [projects.length]);

  const removeProject = useCallback(async () => {
    if (!projectId || projects.length <= 1) {
      setNotice("Create another project before deleting this one.");
      return;
    }
    const next = projects.find((project) => project.id !== projectId);
    if (!next) return;
    await deleteStoryboardProject(projectId);
    if (ownerId) await deleteStoryboardSession(ownerId, projectId).catch(() => undefined);
    setProjects((items) => items.filter((project) => project.id !== projectId));
    await openProject(next.id);
  }, [openProject, ownerId, projectId, projects]);

  const resizeScenes = useCallback((count: number) => {
    setForm((current) => ({
      ...current,
      scenes: Array.from({ length: count }, (_, index) =>
        current.scenes[index] ?? newScene(index, current.globalSeed),
      ),
    }));
  }, []);

  const ensureSavedProject = useCallback(async () => {
    const owner =
      ownerId ||
      (isProductionFirebase ? (await getFirebaseUser()).uid : "demo-user");
    const current = formRef.current;
    if (projectId) {
      await saveStoryboardSession(owner, projectId, projectTitleRef.current, current);
      if (!ownerId) setOwnerId(owner);
      return projectId;
    }
    setSaveState("saving");
    const title = projectTitleRef.current.trim() || "Untitled film";
    const serializable = JSON.parse(
      JSON.stringify(current, (_key, value) =>
        value instanceof File ? undefined : value,
      ),
    ) as Record<string, unknown>;
    const created = await createStoryboardProject(title, serializable);
    await saveStoryboardSession(owner, created.id, created.title, current);
    setOwnerId(owner);
    setProjects((items) =>
      items.some((project) => project.id === created.id)
        ? items
        : [created, ...items],
    );
    setProjectId(created.id);
    setProjectTitle(created.title);
    setReady(true);
    setSaveState("saved");
    setNotice("Private project connected.");
    return created.id;
  }, [ownerId, projectId]);

  const regenerateFrame = useCallback(
    async (sceneId: string, edge: "start" | "end") => {
      const current = formRef.current;
      const scene = current.scenes.find((candidate) => candidate.id === sceneId);
      if (!scene) return;
      const key = `${sceneId}:${edge}`;
      setFrameStates((states) => ({ ...states, [key]: { status: "queued" } }));
      setNotice(`The current ${edge === "start" ? "opening" : "closing"} frame will remain visible while its replacement runs.`);
      try {
        const scopedProjectId = await ensureSavedProject();
        const submitted = await generateStoryboardFrame(current, scene, edge, scopedProjectId);
        setActiveGeneration(submitted);
        setFrameStates((states) => ({ ...states, [key]: { status: "generating" } }));
        const completed = await waitForGeneration(submitted.id);
        setActiveGeneration(completed);
        if (completed.status !== "completed" || completed.output?.kind !== "frame" || !completed.output.downloadUrl) {
          throw new Error(completed.safeErrorMessage || "The replacement frame was not generated.");
        }
        const blob = await fetchGenerationOutput(completed.output.downloadUrl);
        if (!blob.type.startsWith("image/")) throw new Error("The runtime returned an invalid frame artifact.");
        const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
        const file = new File([blob], `${scene.id}-${edge}.${extension}`, { type: blob.type });
        updateScene(sceneId, {
          [edge === "start" ? "startFrame" : "endFrame"]: file,
          [edge === "start" ? "startFrameGenerationId" : "endFrameGenerationId"]: completed.id,
          staleReason: scene.acceptedVideoGenerationId
            ? "A frame anchor changed after this clip was accepted. Render the scene again before assembly."
            : scene.staleReason,
        });
        setFrameStates((states) => ({ ...states, [key]: { status: "idle" } }));
        setNotice(`${edge === "start" ? "Opening" : "Closing"} frame ready for review.`);
      } catch (error) {
        setFrameStates((states) => ({
          ...states,
          [key]: {
            status: "failed",
            error: error instanceof Error ? error.message : "Frame generation failed.",
          },
        }));
        setNotice("The replacement failed. The previous successful frame is unchanged.");
      }
    },
    [ensureSavedProject, updateScene],
  );

  const renderCandidates = useCallback(
    async (sceneId: string, requestedCount?: number) => {
      const current = formRef.current;
      const scene = current.scenes.find((candidate) => candidate.id === sceneId);
      if (!scene) return;
      const candidateCount = Math.min(
        4,
        Math.max(1, Math.round(Number.isFinite(requestedCount) ? Number(requestedCount) : current.candidateCount)),
      );
      setSceneStates((states) => ({ ...states, [sceneId]: { status: "queued" } }));
      const successful = [...(scene.candidateGenerationIds ?? [])].slice(-24);
      try {
        const scopedProjectId = await ensureSavedProject();
        for (let index = 0; index < candidateCount; index += 1) {
          const variation = scene.candidateVariations?.[index];
          const candidateScene = variation
            ? { ...scene, prompt: `${scene.prompt}\n\nControlled draft variation: ${variation}` }
            : scene;
          const submitted = await generateStoryboardScene(current, candidateScene, scopedProjectId);
          setActiveGeneration(submitted);
          setSceneStates((states) => ({ ...states, [sceneId]: { status: "generating" } }));
          const completed = await waitForGeneration(submitted.id);
          setActiveGeneration(completed);
          if (completed.status !== "completed" || completed.output?.kind !== "video") {
            throw new Error(completed.safeErrorMessage || `Draft ${index + 1} was not generated.`);
          }
          successful.push(completed.id);
          updateScene(sceneId, { candidateGenerationIds: [...successful].slice(-24) });
        }
        setSceneStates((states) => ({ ...states, [sceneId]: { status: "idle" } }));
        setNotice("Draft candidates are ready. Technical checks are advisory.");
      } catch (error) {
        setSceneStates((states) => ({
          ...states,
          [sceneId]: {
            status: "failed",
            error: error instanceof Error ? error.message : "Draft generation failed.",
          },
        }));
        setNotice("A draft failed. Every successful candidate remains available.");
      }
    },
    [ensureSavedProject, updateScene],
  );

  const acceptCandidate = useCallback(
    (sceneId: string, generationId: string) => {
      updateScene(sceneId, {
        acceptedVideoGenerationId: generationId,
        staleReason: undefined,
      });
      setNotice("The selected draft is now accepted. Other versions remain recoverable.");
    },
    [updateScene],
  );

  const assemble = useCallback(async () => {
    try {
      const scopedProjectId = await ensureSavedProject();
      const submitted = await assembleStoryboardFilm(formRef.current, scopedProjectId);
      setActiveGeneration(submitted);
      setNotice("Accepted clips entered the authenticated assembly queue.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Assembly could not start.");
    }
  }, [ensureSavedProject]);

  const cancelActive = useCallback(async () => {
    if (!activeGeneration || terminal(activeGeneration)) {
      setNotice("There is no active generation to cancel.");
      return;
    }
    try {
      const cancelled = await cancelGeneration(activeGeneration.id);
      setActiveGeneration(cancelled);
      setNotice("The active owner-authorised generation was cancelled.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cancellation failed.");
    }
  }, [activeGeneration]);

  const addReference = useCallback(
    async (file: File, type: StoryboardProjectReference["type"]) => {
      const assetId = await storeUserAsset(file, "reference");
      if (!assetId) throw new Error("The private reference upload failed.");
      const reference: StoryboardProjectReference = {
        id: crypto.randomUUID(),
        type,
        label: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Reference",
        description: "Private project reference. Add visible continuity details before asking the Director to use it.",
        lockedTraits: [],
        sceneIds: [],
        assetId,
        assetVersionIds: [assetId],
        version: 1,
      };
      setForm((current) => ({ ...current, projectReferences: [...current.projectReferences, reference] }));
      setNotice("Private project reference added. It guides planning; direct LTX conditioning remains capability-gated.");
    },
    [],
  );

  const updateReference = useCallback(
    (referenceId: string, patch: Partial<StoryboardProjectReference>) => {
      setForm((current) => ({
        ...current,
        projectReferences: current.projectReferences.map((reference) =>
          reference.id === referenceId ? { ...reference, ...patch } : reference,
        ),
      }));
    },
    [],
  );

  const removeReference = useCallback((referenceId: string) => {
    setForm((current) => ({
      ...current,
      projectReferences: current.projectReferences.filter((reference) => reference.id !== referenceId),
      scenes: current.scenes.map((scene) => ({
        ...scene,
        referenceIds: scene.referenceIds?.filter((id) => id !== referenceId),
      })),
    }));
    setNotice("Reference removed from the current project. Previous generated versions remain intact.");
  }, []);

  const changeVideoModel = useCallback(async (videoModel: LongFormVideoModel) => {
    const current = formRef.current;
    if ((current.videoModel ?? "ltx-2.3") === videoModel) return;
    const copy = prepareLongFormVideoModelSwitch(current, videoModel);
    const hasRenderedVideo = longFormProjectHasRenderedVideo(current);
    if (!hasRenderedVideo) {
      setForm(copy);
      setNotice(`This project now uses ${videoModel === "ltx-2.5" ? "LTX 2.5 Preview" : "LTX 2.3"}.`);
      return;
    }
    if (!globalThis.confirm(
      "This project already has generated video drafts. Create a separate copy for the selected model so the original stays unchanged?",
    )) return;
    try {
      const label = videoModel === "ltx-2.5" ? "LTX 2.5 Preview" : "LTX 2.3";
      const title = `${projectTitleRef.current} - ${label}`.slice(0, 160);
      const serializable = JSON.parse(JSON.stringify(copy, (_key, value) =>
        value instanceof File ? undefined : value,
      )) as Record<string, unknown>;
      const created = await createStoryboardProject(title, serializable);
      if (ownerId) await saveStoryboardSession(ownerId, created.id, title, copy);
      setProjects((items) => [created, ...items]);
      setProjectId(created.id);
      setProjectTitle(title);
      setForm(copy);
      setCurrentProposal(undefined);
      setUndoForm(undefined);
      setFrameStates({});
      setSceneStates({});
      setNotice(`Created a separate ${label} copy. The original project and generated videos are unchanged.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The model-specific project copy could not be created.");
    }
  }, [ownerId]);

  const addTemporalKeyframe = useCallback(
    async (sceneId: string, file: File) => {
      const current = formRef.current;
      const scene = current.scenes.find((candidate) => candidate.id === sceneId);
      if (!scene) return;
      if (runtime?.capabilities?.intermediateKeyframes !== true) {
        throw new Error("The connected runtime has not verified intermediate frame anchors.");
      }
      const existing = [...(scene.keyframes ?? [])].sort(
        (left, right) => left.timeSeconds - right.timeSeconds,
      );
      const maximum = Math.min(
        MAX_INTERMEDIATE_KEYFRAMES,
        runtime.capabilities.maxIntermediateKeyframes ?? MAX_INTERMEDIATE_KEYFRAMES,
      );
      if (existing.length >= maximum) {
        throw new Error(`This runtime supports up to ${maximum} intermediate frame anchors per scene.`);
      }
      setNotice("Uploading the private intermediate frame anchorâ€¦");
      const frameAssetId = await storeUserAsset(file, `${scene.id}:temporalKeyframe`);
      if (!frameAssetId) throw new Error("The intermediate frame upload failed.");
      const boundaries = [0, ...existing.map((keyframe) => keyframe.timeSeconds), scene.duration];
      let bestStart = 0;
      let bestEnd = 0;
      let largestGap = -1;
      for (let index = 0; index < boundaries.length - 1; index += 1) {
        const gap = boundaries[index + 1] - boundaries[index];
        if (gap > largestGap) {
          largestGap = gap;
          bestStart = boundaries[index];
          bestEnd = boundaries[index + 1];
        }
      }
      const timeSeconds = Number(((bestStart + bestEnd) / 2).toFixed(3));
      updateScene(scene.id, {
        keyframes: [
          ...existing,
          {
            id: `keyframe-${crypto.randomUUID()}`,
            timeSeconds,
            strength: 1,
            frame: file,
            frameAssetId,
          },
        ].sort((left, right) => left.timeSeconds - right.timeSeconds),
        staleReason: scene.acceptedVideoGenerationId
          ? "An intermediate frame anchor changed after this clip was accepted. Render the scene again before assembly."
          : scene.staleReason,
      });
      setNotice("Private intermediate frame anchor added. Review its time before rendering.");
    },
    [runtime, updateScene],
  );

  const executeAcceptedAction = useCallback(
    async (proposal: DirectorProposal) => {
      const sceneId = String(proposal.payload.sceneId ?? proposal.affectedSceneIds[0] ?? formRef.current.scenes[0]?.id ?? "");
      setLastAction(proposal.action);
      switch (proposal.action) {
        case "generate_first_frame":
        case "generate_last_frame":
        case "regenerate_frame":
          await regenerateFrame(sceneId, proposal.payload.edge === "end" ? "end" : "start");
          break;
        case "generate_scene_candidates":
          await renderCandidates(sceneId, Number(proposal.payload.candidateCount));
          break;
        case "generate_scene_video":
        case "retry_job":
          await renderCandidates(sceneId);
          break;
        case "generate_unfinished_scenes":
          for (const scene of formRef.current.scenes.filter((item) => !item.acceptedVideoGenerationId || item.staleReason)) {
            await renderCandidates(scene.id);
          }
          break;
        case "accept_candidate": {
          const scene = formRef.current.scenes.find((item) => item.id === sceneId);
          const index = Number(proposal.payload.candidateNumber) - 1;
          const generationId = scene?.candidateGenerationIds?.[index];
          if (generationId) acceptCandidate(sceneId, generationId);
          else setNotice("That draft number is not available for this scene.");
          break;
        }
        case "restore_candidate": {
          const scene = formRef.current.scenes.find((item) => item.id === sceneId);
          const index = Math.max(0, Number(proposal.payload.candidateNumber || 1) - 1);
          const generationId = scene?.candidateGenerationIds?.[index];
          if (generationId) acceptCandidate(sceneId, generationId);
          else setNotice("The requested previous draft is not available.");
          break;
        }
        case "cancel_job":
          await cancelActive();
          break;
        case "assemble_project":
          await assemble();
          break;
        case "undo_prompt_change":
          if (undoForm) {
            setForm(undoForm);
            setUndoForm(undefined);
            setNotice("The latest Director text change was restored.");
          } else setNotice("No reversible Director text change is available in this session.");
          break;
        case "prepare_finishing":
        case "export_project":
          setNotice(proposal.explanation);
          break;
        default:
          break;
      }
    },
    [acceptCandidate, assemble, cancelActive, regenerateFrame, renderCandidates, undoForm],
  );

  const sendDirection = useCallback(
    async (message: string, selectedSceneId?: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      const userMessage: DirectorMessage = {
        id: crypto.randomUUID(),
        from: "user",
        text: trimmed,
      };
      setMessages((items) => [...items, userMessage]);
      setDirectorBusy(true);
      setNotice("The Director is preparing a bounded proposal. Nothing has changed yet.");
      try {
        const scopedProjectId = await ensureSavedProject();
        const proposal = await createDirectorProposal(
          { projectId: scopedProjectId, message: trimmed, selectedSceneId },
          {
            onProgress: (job) =>
              setNotice(storyboardAsyncProgressMessage(job)),
          },
        );
        setCurrentProposal(proposal.state === "pending" ? proposal : undefined);
        setProposals((items) => [proposal, ...items.filter((item) => item.id !== proposal.id)].slice(0, 50));
        setMessages((items) => [
          ...items,
          {
            id: proposal.id,
            from: "director",
            text: proposal.explanation,
            proposal,
          },
        ]);
        setNotice(proposal.kind === "answer" ? "Director status answer ready." : "Review the Director proposal before applying it.");
      } catch (error) {
        const text = error instanceof Error ? error.message : "The Director could not prepare a proposal.";
        setMessages((items) => [...items, { id: crypto.randomUUID(), from: "director", text }]);
        setNotice(/\bunchanged\b/i.test(text) ? text : `${text} Your project is unchanged.`);
      } finally {
        setDirectorBusy(false);
      }
    },
    [ensureSavedProject],
  );

  useEffect(() => {
    if (!ready || !projectId || resumedDirectorJobRef.current === projectId) return;
    resumedDirectorJobRef.current = projectId;
    let cancelled = false;
    setDirectorBusy(true);
    void resumePendingDirectorProposal(projectId, {
      onProgress: (job) => {
        if (!cancelled) setNotice(storyboardAsyncProgressMessage(job));
      },
    })
      .then((proposal) => {
        if (cancelled || !proposal) return;
        setCurrentProposal(proposal.state === "pending" ? proposal : undefined);
        setProposals((items) => [proposal, ...items.filter((item) => item.id !== proposal.id)].slice(0, 50));
        setMessages((items) => [
          ...items,
          {
            id: proposal.id,
            from: "director",
            text: proposal.explanation,
            proposal,
          },
        ]);
        setNotice(proposal.kind === "answer" ? "Director status answer ready." : "Review the Director proposal before applying it.");
      })
      .catch((error) => {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : "The Director could not resume its proposal.";
        setMessages((items) => [...items, { id: crypto.randomUUID(), from: "director", text }]);
        setNotice(/\bunchanged\b/i.test(text) ? text : `${text} Your project is unchanged.`);
      })
      .finally(() => {
        if (!cancelled) setDirectorBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, ready]);

  const acceptProposal = useCallback(
    async (proposal = currentProposal) => {
      if (!proposal) return;
      setDirectorBusy(true);
      try {
        if (proposal.kind === "draft_change") setUndoForm(formRef.current);
        const result = await acceptDirectorProposal(proposal.id);
        if (result.project) {
          setForm((current) => mergeServerForm(current, result.project!.form));
        }
        setCurrentProposal(undefined);
        setProposals((items) => items.map((item) => (item.id === result.proposal.id ? result.proposal : item)));
        setMessages((items) => items.map((item) => item.proposal?.id === result.proposal.id ? { ...item, proposal: result.proposal } : item));
        setNotice(result.proposal.kind === "draft_change" ? "The reviewed text change was applied and remains editable." : "The reviewed action was authorised through Video Lab.");
        if (result.proposal.kind === "action_request") await executeAcceptedAction(result.proposal);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The proposal could not be accepted.");
      } finally {
        setDirectorBusy(false);
      }
    },
    [currentProposal, executeAcceptedAction],
  );

  const discardProposal = useCallback(
    async (proposal = currentProposal) => {
      if (!proposal) return;
      setDirectorBusy(true);
      try {
        const discarded = await discardDirectorProposal(proposal.id);
        setCurrentProposal(undefined);
        setProposals((items) => items.map((item) => (item.id === discarded.id ? discarded : item)));
        setMessages((items) => items.map((item) => item.proposal?.id === discarded.id ? { ...item, proposal: discarded } : item));
        setNotice("Proposal discarded. Project content and successful media are unchanged.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The proposal could not be discarded.");
      } finally {
        setDirectorBusy(false);
      }
    },
    [currentProposal],
  );

  const totalDuration = useMemo(
    () => form.scenes.reduce((total, scene) => total + scene.duration, 0),
    [form.scenes],
  );
  const acceptedCount = useMemo(
    () => form.scenes.filter((scene) => scene.acceptedVideoGenerationId && !scene.staleReason).length,
    [form.scenes],
  );
  const allAccepted = form.scenes.length > 0 && acceptedCount === form.scenes.length;

  return {
    form,
    setForm,
    projects,
    projectId,
    projectTitle,
    setProjectTitle,
    ready,
    saveState,
    runtime,
    runtimeError,
    frameStates,
    sceneStates,
    activeGeneration,
    proposals,
    currentProposal,
    directorBusy,
    messages,
    notice,
    lastAction,
    totalDuration,
    acceptedCount,
    allAccepted,
    updateScene,
    openProject,
    createProject,
    removeProject,
    resizeScenes,
    changeVideoModel,
    regenerateFrame,
    renderCandidates,
    acceptCandidate,
    assemble,
    cancelActive,
    addReference,
    updateReference,
    removeReference,
    addTemporalKeyframe,
    sendDirection,
    acceptProposal,
    discardProposal,
    setNotice,
  };
}
