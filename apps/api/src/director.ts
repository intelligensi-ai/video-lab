import { defaultGeneratedTextPolicy, MAX_STORYBOARD_SCENES } from "@video-lab/contracts";
import type {
  DirectorActionType,
  DirectorExecutionClass,
  DirectorProposal,
  DirectorProposalKind,
  StoryboardAudioPolicy,
  StoryboardContinuityBible,
  StoryboardEnhancementRequest,
  StoryboardEnhancementResponse,
  StoryboardReferenceSummary,
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

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

export type DirectorIntent = {
  action: DirectorActionType;
  kind: DirectorProposalKind;
  executionClass: DirectorExecutionClass;
  confirmationRequired: boolean;
  sceneCount?: number;
  edge?: "start" | "end";
  candidateNumber?: number;
  candidateCount?: number;
  audioMode?: StoryboardAudioPolicy["mode"];
};

function requestedCount(message: string) {
  const numeric = message.match(/\b(\d{1,2})\s+(?:scenes?|shots?)\b/i);
  if (numeric) return Number(numeric[1]);
  const words = message.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:scenes?|shots?)\b/i,
  );
  return words ? numberWords[words[1].toLowerCase()] : undefined;
}

function requestedCandidate(message: string) {
  const match = message.match(/(?:candidate|draft)\s*([1-9]|1\d|2[0-4])\b/i);
  return match ? Number(match[1]) : undefined;
}

function requestedCandidateCount(message: string) {
  const numeric = message.match(/\b(\d{1,2})\s+(?:drafts?|candidates?|versions?)\b/i);
  if (numeric) return Math.min(4, Math.max(1, Number(numeric[1])));
  const words = message.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:drafts?|candidates?|versions?)\b/i,
  );
  return words
    ? Math.min(4, Math.max(1, numberWords[words[1].toLowerCase()]))
    : undefined;
}

export function classifyDirectorMessage(rawMessage: string): DirectorIntent {
  const message = rawMessage.trim();
  const lower = message.toLowerCase();
  const count = requestedCount(message);
  const candidateNumber = requestedCandidate(message);
  const candidateCount = requestedCandidateCount(message);
  const first = /\b(first|opening|start)\s+frame\b/.test(lower);
  const last = /\b(last|closing|end)\s+frame\b/.test(lower);
  const generate = /\b(generate|create|render)\b/.test(lower);
  const regenerate = /\b(regenerate|replace|redo)\b/.test(lower);

  if (/\b(what is blocking|what's blocking|project status|what remains|what is left)\b/.test(lower)) {
    return { action: "answer_project_question", kind: "answer", executionClass: "none", confirmationRequired: false };
  }
  if (/\b(explain|why)\b/.test(lower) && /\b(fail|error|unavailable)\b/.test(lower)) {
    return { action: "explain_failure", kind: "answer", executionClass: "none", confirmationRequired: false };
  }
  if (/\bcancel\b/.test(lower)) {
    return { action: "cancel_job", kind: "action_request", executionClass: "none", confirmationRequired: true };
  }
  if (/\bretry\b/.test(lower)) {
    return { action: "retry_job", kind: "action_request", executionClass: "draft", confirmationRequired: true };
  }
  if (/\b(export|download)\b/.test(lower)) {
    return { action: "export_project", kind: "action_request", executionClass: "none", confirmationRequired: true };
  }
  if (/\b(assemble|join|complete film|finish film)\b/.test(lower)) {
    return { action: "assemble_project", kind: "action_request", executionClass: "final", confirmationRequired: true };
  }
  if (/\b(prepare|ready)\b/.test(lower) && /\b(finish|finishing)\b/.test(lower)) {
    return { action: "prepare_finishing", kind: "answer", executionClass: "none", confirmationRequired: false };
  }
  if (generate && /\b(unfinished|remaining)\s+(?:scenes?|shots?)\b/.test(lower)) {
    return { action: "generate_unfinished_scenes", kind: "action_request", executionClass: "draft", confirmationRequired: true };
  }
  if ((generate || regenerate) && /\b(drafts?|candidates?|versions?)\b/.test(lower)) {
    return { action: "generate_scene_candidates", kind: "action_request", executionClass: "draft", confirmationRequired: true, candidateCount };
  }
  if (/\b(use|accept|select|choose)\b/.test(lower) && candidateNumber) {
    return { action: "accept_candidate", kind: "action_request", executionClass: "none", confirmationRequired: true, candidateNumber };
  }
  if (/\brestore\b/.test(lower) && /\b(candidate|draft|version)\b/.test(lower)) {
    return { action: "restore_candidate", kind: "action_request", executionClass: "none", confirmationRequired: true, candidateNumber };
  }
  if (/\brestore\b/.test(lower) && /\b(first|opening|last|closing|frame)\b/.test(lower)) {
    return { action: "restore_frame_version", kind: "answer", executionClass: "none", confirmationRequired: false, edge: last ? "end" : "start" };
  }
  if ((generate || regenerate) && (first || last)) {
    return {
      action: regenerate ? "regenerate_frame" : first ? "generate_first_frame" : "generate_last_frame",
      kind: "action_request",
      executionClass: "draft",
      confirmationRequired: true,
      edge: last ? "end" : "start",
    };
  }
  if (generate && /\b(scene|shot|video|clip)\b/.test(lower)) {
    return { action: "generate_scene_video", kind: "action_request", executionClass: "draft", confirmationRequired: true };
  }
  if (/\b(silent|no audio|no sound|mute|muted|remove (?:all )?(?:audio|sound)|turn off (?:audio|sound))\b/.test(lower)) {
    return { action: "set_audio_policy", kind: "draft_change", executionClass: "text", confirmationRequired: false, audioMode: "silent" };
  }
  if (/\b(directed sound|direct the sound|manual sound|sound design|design the sound|control the audio|directed audio)\b/.test(lower)) {
    return { action: "set_audio_policy", kind: "draft_change", executionClass: "text", confirmationRequired: false, audioMode: "directed" };
  }
  if (/\b(only when requested|intent only|conservative audio|remove (?:the )?music|no music|avoid music|turn off music)\b/.test(lower)) {
    return { action: "set_audio_policy", kind: "draft_change", executionClass: "text", confirmationRequired: false, audioMode: "intent_only" };
  }
  if (/\brestore\b/.test(lower) && /\b(original|master|brief)\b/.test(lower)) {
    return { action: "restore_original_prompt", kind: "draft_change", executionClass: "text", confirmationRequired: false };
  }
  if (/\b(remove|delete|stop using|unassign)\b/.test(lower) && (/\breference\b/.test(lower) || message.includes("@"))) {
    return { action: "remove_project_reference", kind: "draft_change", executionClass: "text", confirmationRequired: true };
  }
  if (/\b(use|assign|apply|attach)\b/.test(lower) && (/\breference\b/.test(lower) || message.includes("@"))) {
    return { action: "assign_project_reference", kind: "draft_change", executionClass: "text", confirmationRequired: false };
  }
  if (/\bundo\b/.test(lower)) {
    return { action: "undo_prompt_change", kind: "action_request", executionClass: "text", confirmationRequired: false };
  }
  if (count !== undefined && /\b(scene|shot|storyboard|plan|turn|split)\b/.test(lower)) {
    return {
      action: "plan_storyboard",
      kind: "draft_change",
      executionClass: "text",
      confirmationRequired: true,
      sceneCount: Math.min(MAX_STORYBOARD_SCENES, Math.max(1, count)),
    };
  }
  if (/\b(enhance|polish|rewrite|improve)\b/.test(lower) && /\b(master|brief|idea|story)\b/.test(lower)) {
    return { action: "enhance_master_prompt", kind: "draft_change", executionClass: "text", confirmationRequired: false };
  }
  if (/\b(prompt|frame)\b/.test(lower) && (first || last)) {
    return { action: "propose_frame_prompt_change", kind: "draft_change", executionClass: "text", confirmationRequired: false, edge: last ? "end" : "start" };
  }
  if (/\b(make|change|adjust|refine|strengthen|improve|rewrite|direct|fix|repair|prevent|avoid)\b/.test(lower)) {
    return { action: "propose_scene_change", kind: "draft_change", executionClass: "text", confirmationRequired: false };
  }
  if (/^(what|how|which|where|when|can|is|are|show|tell)\b/.test(lower) || lower.endsWith("?")) {
    return { action: "answer_project_question", kind: "answer", executionClass: "none", confirmationRequired: false };
  }
  return { action: "suggest_creative_direction", kind: "suggestion", executionClass: "none", confirmationRequired: false };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sceneRecords(form: Record<string, unknown>) {
  return Array.isArray(form.scenes)
    ? form.scenes.filter((scene): scene is Record<string, unknown> => Boolean(scene) && typeof scene === "object" && !Array.isArray(scene))
    : [];
}

function continuityBible(form: Record<string, unknown>) {
  const source = asRecord(form.continuityBible);
  return Object.fromEntries(
    continuityKeys.map((key) => [key, typeof source[key] === "string" ? String(source[key]).slice(0, 4_000) : ""]),
  ) as unknown as StoryboardContinuityBible;
}

function audioPolicy(form: Record<string, unknown>): StoryboardAudioPolicy {
  const source = asRecord(form.audioPolicy);
  const mode = ["silent", "intent_only", "directed"].includes(String(source.mode))
    ? (source.mode as StoryboardAudioPolicy["mode"])
    : "intent_only";
  return {
    mode,
    dialogue: mode === "silent" ? "off" : (["off", "prompted_only", "on"].includes(String(source.dialogue)) ? source.dialogue as StoryboardAudioPolicy["dialogue"] : "prompted_only"),
    soundEffects: mode === "silent" ? "off" : (["off", "intent_only", "on"].includes(String(source.soundEffects)) ? source.soundEffects as StoryboardAudioPolicy["soundEffects"] : "intent_only"),
    ambience: mode === "silent" ? "off" : (["off", "intent_only", "on"].includes(String(source.ambience)) ? source.ambience as StoryboardAudioPolicy["ambience"] : "intent_only"),
    music: mode === "silent" ? "off" : (["off", "prompted_or_unambiguous_performance", "on"].includes(String(source.music)) ? source.music as StoryboardAudioPolicy["music"] : "prompted_or_unambiguous_performance"),
    preserveSourceAudio: mode !== "silent" && source.preserveSourceAudio === true,
  };
}

function projectReferences(form: Record<string, unknown>): StoryboardReferenceSummary[] {
  const scenes = sceneRecords(form);
  return (Array.isArray(form.projectReferences) ? form.projectReferences : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((reference) => ({
      id: String(reference.id ?? ""),
      type: String(reference.type ?? "style") as StoryboardReferenceSummary["type"],
      label: String(reference.label ?? "Reference"),
      description: String(reference.description ?? ""),
      lockedTraits: Array.isArray(reference.lockedTraits) ? reference.lockedTraits.map(String) : [],
      version: Math.max(1, Math.round(Number(reference.version) || 1)),
      shotNumbers: Array.isArray(reference.sceneIds)
        ? reference.sceneIds
            .map((sceneId) => scenes.findIndex((scene) => String(scene.id) === String(sceneId)) + 1)
            .filter((shotNumber) => shotNumber > 0)
        : [],
    }));
}

function aspectRatio(resolution: string): "16:9" | "9:16" | "1:1" {
  const [width, height] = resolution.split("x").map(Number);
  if (width === height) return "1:1";
  return width < height ? "9:16" : "16:9";
}

function defaultScene(index: number, globalSeed: number): Record<string, unknown> {
  return {
    id: `scene-${index + 1}`,
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

export function buildDirectorEnhancementRequest(
  form: Record<string, unknown>,
  message: string,
  intent: DirectorIntent,
  selectedSceneId: string | undefined,
  availableControls: string[],
  projectId: string,
): StoryboardEnhancementRequest {
  const currentScenes = sceneRecords(form);
  const requestedSceneCount = intent.action === "plan_storyboard" ? intent.sceneCount ?? currentScenes.length : currentScenes.length;
  const globalSeed = Number(form.globalSeed) || 1337;
  const scenes = Array.from({ length: requestedSceneCount }, (_, index) => currentScenes[index] ?? defaultScene(index, globalSeed));
  const selectedIndex = Math.max(0, scenes.findIndex((scene) => String(scene.id) === selectedSceneId));
  const targetShotNumber = ["propose_scene_change", "propose_frame_prompt_change"].includes(intent.action)
    ? selectedIndex + 1
    : undefined;
  const masterPrompt = String(form.overallGoal ?? "").trim();
  const operation = intent.action === "enhance_master_prompt"
    ? "enhance_master_prompt"
    : intent.action === "plan_storyboard"
      ? "plan_storyboard"
      : intent.action === "propose_frame_prompt_change"
        ? intent.edge === "end" ? "revise_last_frame" : "revise_first_frame"
        : "revise_shot";
  return {
    contractVersion: "2",
    projectId,
    operation,
    userInstruction: message.trim().slice(0, 4_000),
    masterPrompt,
    shotCount: requestedSceneCount,
    generationMode: scenes.some((scene) => scene.startFrameGenerationId || scene.endFrameGenerationId) ? "mixed" : "text_to_video",
    continuityBible: continuityBible(form),
    shots: scenes.map((scene, index) => ({
      shotNumber: index + 1,
      title: String(scene.title ?? `Scene ${index + 1}`),
      narrativePurpose: String(scene.narrativePurpose ?? ""),
      prompt: String(scene.prompt ?? ""),
      firstFramePrompt: String(scene.firstFramePrompt ?? ""),
      lastFramePrompt: String(scene.lastFramePrompt ?? ""),
      continuityNotes: String(scene.continuityNotes ?? ""),
      durationSeconds: Math.min(8, Math.max(1, Math.round(Number(scene.duration) || 5))),
      generationMode: scene.startFrameGenerationId || scene.endFrameGenerationId ? "image_to_video" : "text_to_video",
      referenceIds: Array.isArray(scene.referenceIds) ? scene.referenceIds.map(String) : [],
      selectedControls: Array.isArray(scene.recommendedControls) ? scene.recommendedControls.map(String) : [],
      audioIntent: asRecord(scene.audioIntent).mode
        ? {
            mode: String(asRecord(scene.audioIntent).mode) as StoryboardEnhancementRequest["shots"][number]["audioIntent"]["mode"],
            reason: String(asRecord(scene.audioIntent).reason ?? ""),
            dialogue: String(asRecord(scene.audioIntent).dialogue ?? ""),
            ambience: String(asRecord(scene.audioIntent).ambience ?? ""),
            soundEffects: String(asRecord(scene.audioIntent).soundEffects ?? asRecord(scene.audioIntent).sound_effects ?? ""),
            music: String(asRecord(scene.audioIntent).music ?? ""),
            silence: String(asRecord(scene.audioIntent).silence ?? ""),
          }
        : { mode: "silent", reason: "No scene-specific audio direction has been accepted.", silence: "No scene-specific audio direction has been accepted." },
      generatedTextIntent: asRecord(scene.generatedTextIntent).mode
        ? {
            mode: String(asRecord(scene.generatedTextIntent).mode) as StoryboardEnhancementRequest["shots"][number]["generatedTextIntent"]["mode"],
            visibleText: Array.isArray(asRecord(scene.generatedTextIntent).visibleText)
              ? (asRecord(scene.generatedTextIntent).visibleText as unknown[]).map(String)
              : [],
            reason: String(asRecord(scene.generatedTextIntent).reason ?? ""),
          }
        : { mode: "none", visibleText: [], reason: "Generated visible text is disabled for the minimal launch workflow." },
      carryPreviousFrame: index > 0 && scene.carryPreviousFrame !== false,
      firstFrameAvailable: Boolean(scene.startFrameGenerationId || scene.startFrame),
      lastFrameAvailable: Boolean(scene.endFrameGenerationId || scene.endFrame),
    })),
    targetShotNumber,
    aspectRatio: aspectRatio(String(form.resolution ?? "1280x720")),
    resolution: String(form.resolution ?? "1280x720"),
    references: projectReferences(form),
    availableControls,
    audioPolicy: audioPolicy(form),
    generatedTextPolicy: defaultGeneratedTextPolicy(),
    requestedCandidateCount: Math.min(4, Math.max(1, Number(form.candidateCount) || 3)),
    videoModel: form.videoModel === "ltx-2.5" ? "ltx-2.5" : "ltx-2.3",
  };
}

export function projectStatusAnswer(form: Record<string, unknown>) {
  const scenes = sceneRecords(form);
  const missingFirst = scenes.filter((scene) => !scene.startFrameGenerationId && !scene.startFrame).length;
  const missingLast = scenes.filter((scene) => !scene.endFrameGenerationId && !scene.endFrame).length;
  const accepted = scenes.filter((scene) => scene.acceptedVideoGenerationId && !scene.staleReason).length;
  const stale = scenes.filter((scene) => scene.staleReason).length;
  const blockers = [
    !String(form.overallGoal ?? "").trim() ? "the creative brief is empty" : "",
    missingFirst ? `${missingFirst} opening frame${missingFirst === 1 ? " is" : "s are"} not approved` : "",
    missingLast ? `${missingLast} closing frame${missingLast === 1 ? " is" : "s are"} not approved` : "",
    accepted < scenes.length ? `${scenes.length - accepted} scene${scenes.length - accepted === 1 ? " needs" : "s need"} an accepted current draft` : "",
    stale ? `${stale} accepted clip${stale === 1 ? " is" : "s are"} stale` : "",
  ].filter(Boolean);
  return blockers.length
    ? `This project has ${scenes.length} scene${scenes.length === 1 ? "" : "s"}. Before final assembly, ${blockers.join(", ")}.`
    : `All ${scenes.length} scenes have current accepted clips and the project is ready to prepare for assembly.`;
}

export function proposalCopy(intent: DirectorIntent, form: Record<string, unknown>, selectedSceneId?: string) {
  const scenes = sceneRecords(form);
  const scene = scenes.find((candidate) => String(candidate.id) === selectedSceneId) ?? scenes[0];
  const sceneTitle = String(scene?.title ?? "the selected scene");
  switch (intent.action) {
    case "answer_project_question":
      return { summary: "Project status", explanation: projectStatusAnswer(form) };
    case "explain_failure":
      return { summary: "Generation recovery", explanation: "I can explain a selected failed job once its safe public error is available. Internal runtime details remain hidden." };
    case "suggest_creative_direction":
      return { summary: `Suggestion for ${sceneTitle}`, explanation: "I can propose a targeted prompt change, preserve continuity locks and leave every other scene unchanged. Tell me the creative dimension you want to adjust." };
    case "set_audio_policy":
      return { summary: "Change the project sound policy", explanation: `Set sound behaviour to ${intent.audioMode === "silent" ? "Silent" : intent.audioMode === "directed" ? "Directed sound" : "Only when requested"}. Runtime muxing will enforce the policy.` };
    case "plan_storyboard":
      return { summary: `Plan exactly ${intent.sceneCount} scenes`, explanation: "Gemma prepared an ordered storyboard while application code preserved the requested cardinality." };
    case "enhance_master_prompt":
      return { summary: "Polish the creative brief", explanation: "Gemma prepared an editable brief and continuity bible. The original remains restorable." };
    case "propose_scene_change":
    case "propose_frame_prompt_change":
      return { summary: `Proposed change to ${sceneTitle}`, explanation: "Only the selected scene is affected. Continuity-critical details and unrelated scenes remain unchanged." };
    case "generate_scene_candidates":
      return { summary: `Generate ${intent.candidateCount ?? "the selected"} draft candidates for ${sceneTitle}`, explanation: "Drafts run sequentially for queue fairness and every successful version remains available." };
    case "generate_first_frame":
    case "generate_last_frame":
    case "regenerate_frame":
      return { summary: `${intent.action === "regenerate_frame" ? "Replace" : "Generate"} the ${intent.edge === "end" ? "closing" : "opening"} frame`, explanation: "The current successful frame remains visible until a replacement completes." };
    case "generate_scene_video":
      return { summary: `Generate ${sceneTitle}`, explanation: "The selected scene will enter the authenticated draft queue using its current prompt and approved anchors." };
    case "generate_unfinished_scenes":
      return { summary: "Generate unfinished scenes", explanation: "Only scenes without a current accepted clip will be submitted, one bounded batch at a time." };
    case "assemble_project":
      return { summary: "Assemble the accepted film", explanation: "Assembly uses one current owner-authorised accepted clip per scene and does not rerun LTX." };
    case "prepare_finishing":
      return { summary: "Finishing readiness", explanation: projectStatusAnswer(form) };
    case "cancel_job":
      return { summary: "Cancel the active generation", explanation: "Only an owner-authorised active job can be cancelled. Completed work remains available." };
    case "retry_job":
      return { summary: "Retry the selected operation", explanation: "The original successful media remains preserved while the replacement runs." };
    case "accept_candidate":
      return { summary: `Select draft ${intent.candidateNumber}`, explanation: "This changes the accepted version without deleting any other successful candidate." };
    case "restore_candidate":
      return { summary: "Restore an earlier version", explanation: "The selected previous version becomes current without deleting later versions." };
    case "restore_frame_version":
      return { summary: "Frame-version restore unavailable", explanation: "Video Lab preserves the previous frame while a replacement runs, but it does not yet keep a selectable frame-version stack after replacement. No change was made." };
    case "restore_original_prompt":
      return { summary: "Restore the original creative brief", explanation: "The enhanced brief remains recoverable through project history." };
    case "assign_project_reference":
      return { summary: `Assign a reference to ${sceneTitle}`, explanation: "The existing owner-scoped project reference will guide future Director planning for this scene. This does not claim direct LTX reference conditioning." };
    case "remove_project_reference":
      return { summary: "Remove a project reference", explanation: "The reference will be removed from this project and unassigned from its scenes. Existing generated media is preserved." };
    case "undo_prompt_change":
      return { summary: "Undo the latest prompt change", explanation: "Only the most recent reversible Director change will be restored." };
    case "export_project":
      return { summary: "Export the completed film", explanation: "Export becomes available only after a real same-origin assembled output exists." };
    default:
      return { summary: "Director action", explanation: "Review the affected project state before continuing." };
  }
}

export function applyDirectorProposal(form: Record<string, unknown>, proposal: DirectorProposal) {
  const next = globalThis.structuredClone(form);
  const payload = proposal.payload;
  const enhancement = payload.enhancement as StoryboardEnhancementResponse | undefined;
  const scenes = sceneRecords(next);
  if (enhancement && payload.referencePlanningEvidence) {
    next.referencePlanningEvidence = payload.referencePlanningEvidence;
  }
  if (proposal.action === "set_audio_policy") {
    const mode = String(payload.audioMode) as StoryboardAudioPolicy["mode"];
    next.audioPolicy = {
      ...audioPolicy(next),
      mode,
      ...(payload.music === "off" ? { music: "off" } : {}),
      ...(mode === "silent" ? { dialogue: "off", soundEffects: "off", ambience: "off", music: "off", preserveSourceAudio: false } : {}),
    };
  } else if (proposal.action === "restore_original_prompt" && typeof next.originalOverallGoal === "string") {
    next.overallGoal = next.originalOverallGoal;
  } else if (proposal.action === "assign_project_reference") {
    const referenceId = String(payload.referenceId ?? "");
    const targetId = proposal.affectedSceneIds[0];
    next.scenes = scenes.map((scene) => String(scene.id) === targetId
      ? { ...scene, referenceIds: [...new Set([...(Array.isArray(scene.referenceIds) ? scene.referenceIds.map(String) : []), referenceId])] }
      : scene);
  } else if (proposal.action === "remove_project_reference") {
    const referenceId = String(payload.referenceId ?? "");
    next.projectReferences = projectReferences(next).filter((reference) => reference.id !== referenceId);
    next.scenes = scenes.map((scene) => ({
      ...scene,
      referenceIds: Array.isArray(scene.referenceIds) ? scene.referenceIds.map(String).filter((id) => id !== referenceId) : [],
    }));
  } else if (proposal.action === "enhance_master_prompt" && enhancement) {
    next.originalOverallGoal = next.originalOverallGoal ?? next.overallGoal;
    next.overallGoal = enhancement.polishedMasterPrompt;
    next.negativePrompt = enhancement.negativePrompt;
    next.continuityBible = enhancement.continuityBible;
    next.directorAssumptions = enhancement.assumptions;
    next.instructionBundle = enhancement.instructionBundle;
  } else if (proposal.action === "plan_storyboard" && enhancement) {
    next.originalOverallGoal = next.originalOverallGoal ?? next.overallGoal;
    next.overallGoal = enhancement.polishedMasterPrompt;
    next.negativePrompt = enhancement.negativePrompt;
    next.continuityBible = enhancement.continuityBible;
    next.directorAssumptions = enhancement.assumptions;
    next.instructionBundle = enhancement.instructionBundle;
    const globalSeed = Number(next.globalSeed) || 1337;
    next.scenes = enhancement.shots.map((shot, index) => ({
      ...(scenes[index] ?? defaultScene(index, globalSeed)),
      id: String(scenes[index]?.id ?? `scene-${index + 1}`),
      title: shot.title,
      narrativePurpose: shot.narrativePurpose,
      prompt: shot.prompt,
      firstFramePrompt: shot.firstFramePrompt,
      lastFramePrompt: shot.lastFramePrompt,
      continuityNotes: shot.continuityNotes,
      referenceIds: shot.referenceIds,
      recommendedControls: shot.recommendedControls,
      audioIntent: shot.audioIntent,
      candidateVariations: shot.candidateVariations,
      promptOrigin: "agent",
      staleReason: scenes[index]?.acceptedVideoGenerationId ? "The storyboard direction changed after this clip was accepted." : undefined,
    }));
  } else if (["propose_scene_change", "propose_frame_prompt_change"].includes(proposal.action) && enhancement?.shots.length) {
    const targetId = proposal.affectedSceneIds[0];
    const targetShotNumber = scenes.findIndex((scene) => String(scene.id) === targetId) + 1;
    const shot = enhancement.shots.find((candidate) => candidate.shotNumber === targetShotNumber);
    if (!shot) return next;
    next.scenes = scenes.map((scene) => {
      if (String(scene.id) !== targetId) return scene;
      if (proposal.action === "propose_frame_prompt_change") {
        return {
          ...scene,
          [payload.edge === "end" ? "lastFramePrompt" : "firstFramePrompt"]:
            payload.edge === "end" ? shot.lastFramePrompt : shot.firstFramePrompt,
          promptOrigin: "agent",
          staleReason: scene.acceptedVideoGenerationId ? "A frame prompt changed after this clip was accepted." : scene.staleReason,
        };
      }
      return {
        ...scene,
        title: shot.title,
        narrativePurpose: shot.narrativePurpose,
        prompt: shot.prompt,
        firstFramePrompt: shot.firstFramePrompt,
        lastFramePrompt: shot.lastFramePrompt,
        continuityNotes: shot.continuityNotes,
        referenceIds: shot.referenceIds,
        recommendedControls: shot.recommendedControls,
        audioIntent: shot.audioIntent,
        candidateVariations: shot.candidateVariations,
        promptOrigin: "agent",
        staleReason: scene.startFrameGenerationId || scene.endFrameGenerationId || scene.acceptedVideoGenerationId
          ? "The Director changed this scene after media was generated. Review or regenerate its dependent outputs."
          : scene.staleReason,
      };
    });
  }
  return next;
}
