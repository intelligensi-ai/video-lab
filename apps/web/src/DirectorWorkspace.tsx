import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  defaultGeneratedTextPolicy,
  type DirectorProposal,
  type Generation,
  type LongFormVideoModel,
  type StoryboardGeneratedTextPolicy,
} from "@video-lab/contracts";
import {
  fetchGenerationOutput,
  fetchUserAsset,
  getGeneration,
  type StoryboardProjectReference,
  type StoryboardScenePayload,
  type StoryboardTemporalKeyframePayload,
} from "./api.js";
import { AuthenticatedVideo } from "./AuthenticatedVideo.js";
import {
  useDirectorWorkspace,
  type WorkspaceFrameState,
} from "./useDirectorWorkspace.js";
import "./DirectorWorkspace.css";
import {
  longFormVideoModelLabel,
  longFormVideoModelsForRuntime,
} from "./longFormVideoModels.js";

type Stage = {
  label: string;
  shortLabel: string;
  eyebrow: string;
  description: string;
};
type MobilePane = "canvas" | "assets" | "director";

const stages: Stage[] = [
  {
    label: "Idea",
    shortLabel: "Idea",
    eyebrow: "Creative brief",
    description: "Shape the story, format and sound before planning individual scenes.",
  },
  {
    label: "Cast & look",
    shortLabel: "Cast",
    eyebrow: "Project references",
    description: "Define the people, places and visual language that should remain consistent.",
  },
  {
    label: "Storyboard",
    shortLabel: "Board",
    eyebrow: "Scene direction",
    description: "Review the narrative beat, prompts and visual handoff for every scene.",
  },
  {
    label: "Frames",
    shortLabel: "Frames",
    eyebrow: "Visual anchors",
    description: "Approve the beginning and ending composition before generating motion.",
  },
  {
    label: "Draft videos",
    shortLabel: "Drafts",
    eyebrow: "Candidate review",
    description: "Compare real drafts and choose the strongest creative direction.",
  },
  {
    label: "Finish",
    shortLabel: "Finish",
    eyebrow: "Final assembly",
    description: "Assemble current accepted scenes after the runtime capability has been validated.",
  },
];

const referenceTypes: Array<{
  value: StoryboardProjectReference["type"];
  label: string;
}> = [
  { value: "character", label: "Character" },
  { value: "location", label: "Location" },
  { value: "product", label: "Product or prop" },
  { value: "style", label: "Visual style" },
  { value: "voice", label: "Voice planning (description only)" },
  { value: "motion", label: "Motion planning (description only)" },
];

function statusLabel(scene: StoryboardScenePayload) {
  if (scene.acceptedVideoGenerationId && !scene.staleReason) return "Accepted";
  if (scene.candidateGenerationIds?.length) return "Drafts ready";
  if (scene.startFrameGenerationId && scene.endFrameGenerationId) return "Frames ready";
  if (scene.staleReason) return "Needs review";
  return "Planned";
}

function soundLabel(mode: string) {
  if (mode === "silent") return "Silent";
  if (mode === "directed") return "Directed sound";
  return "Only when requested";
}

function objectUrl(file?: File) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

export default function DirectorWorkspace() {
  const workspace = useDirectorWorkspace();
  const [activeStage, setActiveStage] = useState(0);
  const [mobilePane, setMobilePane] = useState<MobilePane>("canvas");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [directorInput, setDirectorInput] = useState("");
  const [format, setFormat] = useState("Short film");
  const [referenceType, setReferenceType] = useState<StoryboardProjectReference["type"]>("character");
  const [helpOpen, setHelpOpen] = useState(false);
  const referenceInput = useRef<HTMLInputElement>(null);

  const scenes = workspace.form.scenes;
  const selectedScene =
    scenes.find((scene) => scene.id === selectedSceneId) ?? scenes[0];
  const selectedIndex = Math.max(0, scenes.findIndex((scene) => scene.id === selectedScene?.id));
  const minimumSceneDuration = Math.min(
    8,
    Math.max(
      1,
      Math.ceil(
        Math.max(
          0,
          ...(selectedScene?.keyframes ?? []).map(
            (keyframe) => keyframe.timeSeconds,
          ),
        ) + 0.1,
      ),
    ),
  );

  useEffect(() => {
    if (!selectedSceneId && scenes[0]) setSelectedSceneId(scenes[0].id);
    if (selectedSceneId && !scenes.some((scene) => scene.id === selectedSceneId)) {
      setSelectedSceneId(scenes[0]?.id ?? "");
    }
  }, [scenes, selectedSceneId]);

  useEffect(() => {
    if (["generate_scene_candidates", "accept_candidate", "restore_candidate"].includes(workspace.lastAction ?? "")) {
      setActiveStage(4);
    }
    if (["assemble_project", "prepare_finishing", "export_project"].includes(workspace.lastAction ?? "")) {
      setActiveStage(5);
    }
  }, [workspace.lastAction]);

  const usedReferenceIds = useMemo(
    () => new Set(selectedScene?.referenceIds ?? []),
    [selectedScene?.referenceIds],
  );

  const chooseScene = (id: string) => {
    setSelectedSceneId(id);
    setActiveStage(2);
    setMobilePane("canvas");
  };

  const markPromptChanged = (patch: Partial<StoryboardScenePayload>) => {
    if (!selectedScene) return;
    workspace.updateScene(selectedScene.id, {
      ...patch,
      promptOrigin: "user",
      staleReason: selectedScene.acceptedVideoGenerationId
        ? "This direction changed after the current clip was accepted. Generate a replacement before assembly."
        : selectedScene.staleReason,
    });
  };

  const sendDirection = async (message = directorInput) => {
    if (!message.trim()) return;
    setDirectorInput("");
    setMobilePane("director");
    await workspace.sendDirection(message, selectedScene?.id);
  };

  const requestFrame = (edge: "start" | "end") => {
    if (!selectedScene) return;
    void sendDirection(
      `${selectedScene[edge === "start" ? "startFrameGenerationId" : "endFrameGenerationId"] ? "Regenerate" : "Generate"} the ${edge === "start" ? "first" : "last"} frame for Scene ${selectedIndex + 1}.`,
    );
  };

  const requestDrafts = () => {
    if (!selectedScene) return;
    void sendDirection(
      `Generate ${workspace.form.candidateCount} draft candidates for Scene ${selectedIndex + 1}.`,
    );
  };

  const downloadCurrent = async () => {
    const generation = workspace.activeGeneration;
    if (generation?.status !== "completed" || !generation.output?.downloadUrl) {
      workspace.setNotice("A completed same-origin film output is required before export.");
      return;
    }
    try {
      const blob = await fetchGenerationOutput(generation.output.downloadUrl);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${workspace.projectTitle.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "video-lab-film"}.${blob.type === "video/webm" ? "webm" : "mp4"}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      workspace.setNotice("Private film download prepared from the Video Lab origin.");
    } catch (error) {
      workspace.setNotice(error instanceof Error ? error.message : "The film could not be downloaded.");
    }
  };

  if (!workspace.ready || !selectedScene) {
    return (
      <main className="vlx-shell vlx-loading-page">
        <p>{workspace.notice}</p>
      </main>
    );
  }

  const runtimeReady = workspace.runtime?.status === "healthy" && workspace.runtime.acceptingSubmissions;
  const assemblySupported = workspace.runtime?.capabilities?.sceneAssembly === true;
  const referenceConditioningSupported =
    workspace.runtime?.capabilities?.referenceConditioning === true &&
    workspace.runtime?.capabilities?.featureStatus?.referenceConditioning === "supported";
  const videoModels = longFormVideoModelsForRuntime(workspace.runtime);

  return (
    <main className="vlx-shell" data-mobile-pane={mobilePane}>
      <header className="vlx-project-bar">
        <div className="vlx-brand">
          <span className="vlx-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><span>Video Lab</span><strong>Director workspace</strong></div>
        </div>
        <div className="vlx-project-switcher">
          <select
            aria-label="Open project"
            value={workspace.projectId}
            onChange={(event) => void workspace.openProject(event.target.value)}
          >
            {workspace.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.title}</option>
            ))}
          </select>
          <label className="vlx-project-name">
            <span className="sr-only">Project name</span>
            <input value={workspace.projectTitle} onChange={(event) => workspace.setProjectTitle(event.target.value)} />
            <small>{workspace.saveState === "saving" ? "Saving…" : workspace.saveState === "error" ? "Save unavailable" : "Private project saved"}</small>
          </label>
        </div>
        <div className="vlx-project-actions">
          <span className="vlx-experiment">Connected preview</span>
          <button type="button" className="vlx-quiet" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}>Help</button>
          <Link className="vlx-quiet" to="/videolab">Classic studio</Link>
          <button type="button" className="vlx-export" onClick={() => void downloadCurrent()}>Export film</button>
        </div>
      </header>

      {helpOpen && (
        <section className="vlx-help" role="note">
          Ask the Director in plain language, review every proposed change, then use the visual workspace for prompts, frames and candidate comparison. Unsupported controls stay unavailable until the active runtime proves them.
        </section>
      )}

      <nav className="vlx-stage-nav" aria-label="Creative workflow">
        {stages.map((stage, index) => (
          <button
            key={stage.label}
            type="button"
            className={activeStage === index ? "active" : index < activeStage ? "complete" : ""}
            aria-current={activeStage === index ? "step" : undefined}
            onClick={() => { setActiveStage(index); setMobilePane("canvas"); }}
          >
            <span>{index + 1}</span><b>{stage.shortLabel}</b>
          </button>
        ))}
      </nav>

      <div className="vlx-workspace">
        <aside className="vlx-left" aria-label="Project references">
          <div className="vlx-rail-heading">
            <div><span className="vlx-eyebrow">Project library</span><h2>References</h2></div>
            <button type="button" aria-label="Add a private reference" onClick={() => referenceInput.current?.click()}>+</button>
          </div>
          <p className="vlx-rail-copy">
            {referenceConditioningSupported
              ? "References guide Gemma’s continuity plan and the connected runtime conditions generation on them directly."
              : "References guide Gemma’s continuity plan. Direct LTX conditioning remains capability-gated."}
          </p>
          <label className="vlx-reference-type">
            <span>New reference type</span>
            <select value={referenceType} onChange={(event) => setReferenceType(event.target.value as StoryboardProjectReference["type"])}>
              {referenceTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>
          <input
            ref={referenceInput}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void workspace.addReference(file, referenceType).catch((error) => workspace.setNotice(error instanceof Error ? error.message : "Reference upload failed."));
              event.target.value = "";
            }}
          />
          <div className="vlx-reference-list">
            {workspace.form.projectReferences.length ? workspace.form.projectReferences.map((reference) => {
              const selected = reference.sceneIds.length === 0 || usedReferenceIds.has(reference.id);
              return (
                <button
                  key={reference.id}
                  type="button"
                  className={`vlx-reference ${selected ? "selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    const next = new Set(selectedScene.referenceIds ?? []);
                    if (next.has(reference.id)) next.delete(reference.id); else next.add(reference.id);
                    markPromptChanged({ referenceIds: [...next] });
                  }}
                >
                  <PrivateReferenceArt reference={reference} />
                  <span><small>{reference.type}</small><strong>{reference.label}</strong><em>{reference.description}</em></span>
                  <b>{selected ? "Used" : "Add"}</b>
                </button>
              );
            }) : <p className="vlx-empty">Add a character, place, product or style reference when continuity matters.</p>}
          </div>
          <button type="button" className="vlx-library-button" onClick={() => setActiveStage(1)}>Open reference library</button>
        </aside>

        <section className="vlx-main" aria-label={stages[activeStage].label}>
          <header className="vlx-canvas-heading">
            <div><span className="vlx-eyebrow">{stages[activeStage].eyebrow}</span><h1>{stages[activeStage].label}</h1><p>{stages[activeStage].description}</p></div>
            <div className={runtimeReady ? "vlx-ready" : "vlx-ready unavailable"}><i /> {runtimeReady ? "Ready to create" : "Generator unavailable"}</div>
          </header>

          <div className="vlx-notice" role="status">
            <span>{workspace.activeGeneration ? workspace.activeGeneration.status : runtimeReady ? "Connected" : "Degraded"}</span>
            <p>{workspace.runtimeError || workspace.notice}</p>
          </div>

          {workspace.activeGeneration && !["completed", "failed", "cancelled"].includes(workspace.activeGeneration.status) && (
            <div className="vlx-live-job" aria-live="polite">
              <div><strong>{workspace.activeGeneration.runtimeMessage || "Generation in progress"}</strong><span>{workspace.activeGeneration.queuePosition ? `Queue position ${workspace.activeGeneration.queuePosition}` : `${workspace.activeGeneration.progress ?? 0}%`}</span></div>
              <progress max={100} value={workspace.activeGeneration.progress ?? 0} />
              <button type="button" onClick={() => void workspace.cancelActive()}>Cancel</button>
            </div>
          )}

          {activeStage === 0 && (
            <section className="vlx-card vlx-idea-card">
              <div className="vlx-section-title"><div><span className="vlx-eyebrow">Your creation</span><h2>What would you like to make?</h2></div><span className="vlx-agent-badge">Director-assisted</span></div>
              <label className="vlx-field vlx-brief-field">
                <span>Describe your idea in your own words</span>
                <textarea
                  value={workspace.form.overallGoal}
                  onChange={(event) => workspace.setForm((current) => ({
                    ...current,
                    overallGoal: event.target.value,
                    scenes: current.scenes.map((scene) => scene.acceptedVideoGenerationId ? { ...scene, staleReason: "The creative brief changed after this clip was accepted." } : scene),
                  }))}
                />
                <small>No cinematic prompting knowledge needed. Suggestions stay editable.</small>
              </label>
              <div className="vlx-setting-grid">
                <label className="vlx-field"><span>Video model</span><select aria-label="Video model" value={workspace.form.videoModel ?? "ltx-2.3"} onChange={(event) => void workspace.changeVideoModel(event.target.value as LongFormVideoModel)}>{videoModels.map((model) => <option key={model.id} value={model.id} disabled={!model.available}>{longFormVideoModelLabel(model)}</option>)}</select><small>{videoModels.find((model) => model.id === (workspace.form.videoModel ?? "ltx-2.3"))?.reason ?? "Existing projects stay pinned; switching a rendered project creates a separate copy."}</small></label>
                <label className="vlx-field"><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value)}><option>Short film</option><option>Product story</option><option>Social video</option><option>Film trailer</option></select></label>
                <label className="vlx-field"><span>Scenes</span><select value={scenes.length} onChange={(event) => workspace.resizeScenes(Number(event.target.value))}>{Array.from({ length: Math.min(24, workspace.runtime?.capabilities?.maxScenes ?? 24) }, (_, index) => <option key={index + 1}>{index + 1}</option>)}</select></label>
                <label className="vlx-field"><span>Frame</span><select value={workspace.form.resolution} onChange={(event) => workspace.setForm((current) => ({ ...current, resolution: event.target.value }))}><option value="1280x720">Landscape 16:9</option><option value="720x1280">Vertical 9:16</option><option value="1080x1080">Square 1:1</option></select></label>
                <label className="vlx-field"><span>Sound</span><select value={workspace.form.audioPolicy.mode} onChange={(event) => workspace.setForm((current) => ({ ...current, audioPolicy: { ...current.audioPolicy, mode: event.target.value as StoryboardAudioPolicyMode } }))}><option value="silent">Silent</option><option value="intent_only">Only when requested</option><option value="directed">Directed sound</option></select></label>
              </div>
              <div className="vlx-call-to-action">
                <span><b>{workspace.totalDuration}s</b> planned runtime</span>
                <button type="button" disabled={!workspace.form.overallGoal.trim() || workspace.directorBusy} onClick={() => void sendDirection(`Plan this creative brief into exactly ${scenes.length} scenes while preserving my intent.`)}>Direct my storyboard</button>
              </div>
              <div className="vlx-project-tools"><button type="button" className="vlx-secondary" onClick={() => void workspace.createProject()}>New project</button><button type="button" className="vlx-secondary" disabled={workspace.projects.length <= 1} onClick={() => void workspace.removeProject()}>Delete project</button></div>
            </section>
          )}

          {activeStage === 1 && (
            <section className="vlx-card">
              <div className="vlx-section-title"><div><span className="vlx-eyebrow">Continuity</span><h2>Cast, world and look</h2></div><button type="button" className="vlx-secondary" onClick={() => referenceInput.current?.click()}>Add reference</button></div>
              <p className="vlx-capability-truth">
                {referenceConditioningSupported
                  ? "These references are private, available to Gemma for planning, and the connected runtime conditions each scene's generation on them directly."
                  : "These references are private and available to Gemma for planning. The active LongForm runtime currently proves direct conditioning only through each scene’s first and last frame."}
              </p>
              <div className="vlx-reference-board">
                {workspace.form.projectReferences.map((reference) => (
                  <article key={reference.id} className="vlx-reference-tile">
                    <PrivateReferenceArt reference={reference} hero />
                    <label><span>Name</span><input value={reference.label} onChange={(event) => workspace.updateReference(reference.id, { label: event.target.value })} /></label>
                    <label><span>Visible continuity details</span><textarea value={reference.description} onChange={(event) => workspace.updateReference(reference.id, { description: event.target.value })} /></label>
                    <small>{reference.sceneIds.length ? `Assigned to ${reference.sceneIds.length} scenes` : "Available project-wide"}</small>
                    <DirectorReferenceEvidence
                      reference={reference}
                      sceneIds={scenes.map((scene) => scene.id)}
                      evidence={workspace.form.referencePlanningEvidence}
                    />
                    <button type="button" className="vlx-secondary" onClick={() => workspace.removeReference(reference.id)}>Remove</button>
                  </article>
                ))}
                <button type="button" className="vlx-add-tile" onClick={() => referenceInput.current?.click()}><span>+</span><b>Add another reference</b><small>Character, location, product, style or planning reference</small></button>
              </div>
            </section>
          )}

          {(activeStage === 2 || activeStage === 3) && (
            <section className="vlx-scene-workspace">
              <div className="vlx-scene-header">
                <div><span className="vlx-scene-index">Scene {selectedIndex + 1} of {scenes.length}</span><input aria-label="Scene title" value={selectedScene.title} onChange={(event) => markPromptChanged({ title: event.target.value })} /><textarea className="vlx-purpose" aria-label="Narrative purpose" value={selectedScene.narrativePurpose ?? ""} placeholder="What should this scene accomplish?" onChange={(event) => markPromptChanged({ narrativePurpose: event.target.value })} /></div>
                <div className="vlx-scene-meta"><label><span className="sr-only">Duration</span><input type="number" min={minimumSceneDuration} max={8} value={selectedScene.duration} onChange={(event) => markPromptChanged({ duration: Math.min(8, Math.max(minimumSceneDuration, Number(event.target.value))) })} /> seconds</label><b>{statusLabel(selectedScene)}</b></div>
              </div>
              <div className="vlx-frame-pair">
                <FrameCard edge="First frame" prompt={selectedScene.firstFramePrompt ?? ""} file={selectedScene.startFrame} state={workspace.frameStates[`${selectedScene.id}:start`] ?? { status: "idle" }} position="first" onPrompt={(firstFramePrompt) => markPromptChanged({ firstFramePrompt })} onRegenerate={() => requestFrame("start")} />
                <div className="vlx-motion-bridge"><span>Camera and action</span><i><b /></i><p>{selectedScene.continuityNotes || "The LTX prompt defines the movement between these still-image anchors."}</p></div>
                <FrameCard edge="Last frame" prompt={selectedScene.lastFramePrompt ?? ""} file={selectedScene.endFrame} state={workspace.frameStates[`${selectedScene.id}:end`] ?? { status: "idle" }} position="last" onPrompt={(lastFramePrompt) => markPromptChanged({ lastFramePrompt })} onRegenerate={() => requestFrame("end")} />
              </div>
              {workspace.runtime?.capabilities?.intermediateKeyframes ? (
                <TemporalKeyframeEditor
                  scene={selectedScene}
                  maximum={workspace.runtime.capabilities.maxIntermediateKeyframes ?? 6}
                  onAdd={(file) => workspace.addTemporalKeyframe(selectedScene.id, file)}
                  onChange={(keyframes) => markPromptChanged({ keyframes })}
                />
              ) : (
                <p className="vlx-capability-truth">Intermediate frame anchors stay hidden until the connected runtime advertises and verifies its ordered multi-keyframe workflow.</p>
              )}
              <details className="vlx-prompt-editor" open={activeStage === 2}>
                <summary><span><small>Editable LTX direction</small><b>Scene video prompt</b></span><em>{selectedScene.promptOrigin === "agent" ? "Director suggested" : "User authored"}</em></summary>
                <textarea value={selectedScene.prompt} onChange={(event) => markPromptChanged({ prompt: event.target.value })} />
                <div className="vlx-prompt-footer"><span>Uses {selectedScene.referenceIds?.length ?? 0} selected planning references</span><button type="button" onClick={() => { setMobilePane("director"); setDirectorInput(`Improve Scene ${selectedIndex + 1} without changing its continuity-critical details.`); }}>Ask Director</button></div>
              </details>
              {selectedScene.staleReason && <p className="vlx-stale" role="status">{selectedScene.staleReason}</p>}
              <div className="vlx-generation-bar"><div><span>Generate {workspace.form.candidateCount} draft clips</span><small>Queue and time estimates appear only when the connected runtime provides reliable data. Sound: {soundLabel(workspace.form.audioPolicy.mode)}.</small></div><button type="button" disabled={!runtimeReady || !selectedScene.prompt.trim() || workspace.directorBusy} onClick={requestDrafts}>Review draft request</button></div>
              {workspace.sceneStates[selectedScene.id]?.status === "failed" && <p className="vlx-error" role="alert">{workspace.sceneStates[selectedScene.id].error} Previous successful drafts are unchanged.</p>}
            </section>
          )}

          {activeStage === 4 && (
            <section className="vlx-card vlx-drafts">
              <div className="vlx-section-title"><div><span className="vlx-eyebrow">{selectedScene.title}</span><h2>Compare draft candidates</h2></div><span className="vlx-usage">{selectedScene.candidateGenerationIds?.length ?? 0} saved drafts · {selectedScene.duration}s each</span></div>
              <CandidateGrid scene={selectedScene} onAccept={(generationId) => workspace.acceptCandidate(selectedScene.id, generationId)} />
              <button type="button" className="vlx-secondary" disabled={!runtimeReady || workspace.directorBusy} onClick={requestDrafts}>Request more drafts</button>
              <p className="vlx-advisory">Quality checks cover media integrity only. Identity, prompt adherence, anatomy and artistic quality are not evaluated and are never invented.</p>
            </section>
          )}

          {activeStage === 5 && (
            <section className="vlx-card vlx-finish">
              <div className="vlx-section-title"><div><span className="vlx-eyebrow">Final assembly</span><h2>Shape the finished film</h2></div><span className="vlx-usage">{workspace.acceptedCount}/{scenes.length} current scenes accepted</span></div>
              <div className="vlx-finish-preview">
                {workspace.activeGeneration?.status === "completed" && workspace.activeGeneration.output?.kind === "video" && workspace.activeGeneration.output.downloadUrl ? <AuthenticatedVideo downloadUrl={workspace.activeGeneration.output.downloadUrl} /> : <div className="vlx-finish-placeholder">A real assembled preview will appear here after the capability-gated job completes.</div>}
              </div>
              <div className="vlx-finish-timeline">{scenes.map((scene, index) => <span key={scene.id} className={scene.acceptedVideoGenerationId && !scene.staleReason ? "ready" : "waiting"} style={{ flex: scene.duration }}>{index + 1}<small>{scene.duration}s</small></span>)}</div>
              <div className="vlx-finish-options">
                <label className="vlx-field"><span>Finishing</span><select value={workspace.form.postProcess} onChange={(event) => workspace.setForm((current) => ({ ...current, postProcess: event.target.value }))}><option value="none">Draft — no extra pass</option><option value="interpolate">Smoother motion</option><option value="upscale">Upscaled delivery</option><option value="both">Smooth and upscale</option></select></label>
                <label className="vlx-field"><span>Sound</span><select value={workspace.form.audioPolicy.mode} onChange={(event) => workspace.setForm((current) => ({ ...current, audioPolicy: { ...current.audioPolicy, mode: event.target.value as StoryboardAudioPolicyMode } }))}><option value="silent">Silent</option><option value="intent_only">Only when requested</option><option value="directed">Directed sound</option></select></label>
                <label className="vlx-field"><span>Delivery</span><select value={workspace.form.outputFormat} onChange={(event) => workspace.setForm((current) => ({ ...current, outputFormat: event.target.value }))}><option value="mp4">MP4</option><option value="webm">WebM</option></select></label>
                <label className="vlx-field"><span>On-screen text</span><select value={workspace.form.generatedTextPolicy.mode} onChange={(event) => workspace.setForm((current) => ({ ...current, generatedTextPolicy: generatedTextPolicyForMode(current.generatedTextPolicy, event.target.value as StoryboardGeneratedTextPolicy["mode"]) }))}><option value="forbidden">Never generate visible text</option><option value="prompted_only">Only when explicitly requested</option><option value="allowed">Allowed where it fits the scene</option></select></label>
              </div>
              {workspace.form.generatedTextPolicy.mode !== "forbidden" && (
                <details className="vlx-frame-details">
                  <summary>On-screen text details</summary>
                  <div className="vlx-finish-options">
                    {(
                      [
                        ["captions", "Captions"],
                        ["subtitles", "Subtitles"],
                        ["closedCaptions", "Closed captions"],
                        ["titleCards", "Title cards"],
                        ["textOverlays", "Text overlays"],
                        ["logos", "Logos"],
                        ["watermarks", "Watermarks"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="vlx-toggle">
                        <input
                          type="checkbox"
                          checked={workspace.form.generatedTextPolicy[key]}
                          onChange={(event) => workspace.setForm((current) => ({ ...current, generatedTextPolicy: { ...current.generatedTextPolicy, [key]: event.target.checked } }))}
                        />
                        <span /> {label}
                      </label>
                    ))}
                    <label className="vlx-field"><span>Readable signage</span><select value={workspace.form.generatedTextPolicy.signage} onChange={(event) => workspace.setForm((current) => ({ ...current, generatedTextPolicy: { ...current.generatedTextPolicy, signage: event.target.value as StoryboardGeneratedTextPolicy["signage"] } }))}><option value="avoid_readable_text">Avoid readable text</option><option value="incidental">Incidental only</option><option value="allowed">Allowed</option></select></label>
                  </div>
                </details>
              )}
              {!assemblySupported && <p className="vlx-capability-truth">Accepted-scene assembly is unavailable on the connected runtime and will not be simulated.</p>}
              <div className="vlx-generation-bar"><div><span>Assemble accepted scenes</span><small>{workspace.allAccepted ? "Ready for a confirmation proposal." : `${scenes.length - workspace.acceptedCount} scenes still need a current accepted draft.`}</small></div><button type="button" disabled={!workspace.allAccepted || !assemblySupported || workspace.directorBusy} onClick={() => void sendDirection("Assemble the accepted scenes into the complete film.")}>Review assembly request</button></div>
            </section>
          )}
        </section>

        <aside className="vlx-right" aria-label="Gemma Director">
          <header className="vlx-director-heading"><div className="vlx-director-avatar"><span>G</span><i /></div><div><span className="vlx-eyebrow">Creative assistant</span><h2>Director</h2></div><button type="button" aria-label="Show Director history" onClick={() => workspace.setNotice(`${workspace.proposals.length} owner-scoped Director proposals are stored for this project.`)}>•••</button></header>
          <div className="vlx-director-context"><span>Working on</span><strong>Scene {selectedIndex + 1}: {selectedScene.title}</strong></div>
          <div className="vlx-director-thread">
            {workspace.messages.map((message) => (
              <div key={message.id} className={message.from === "user" ? "user" : "director"}>
                <small>{message.from === "user" ? "You" : "Gemma Director"}</small><p>{message.text}</p>
                {message.proposal && <ProposalCard proposal={message.proposal} busy={workspace.directorBusy} onAccept={() => void workspace.acceptProposal(message.proposal)} onEdit={() => { void workspace.discardProposal(message.proposal); setDirectorInput(`Revise this proposal: ${message.proposal?.summary}. `); }} onDiscard={() => void workspace.discardProposal(message.proposal)} />}
              </div>
            ))}
            {workspace.directorBusy && <div className="director"><small>Gemma Director</small><p>Preparing a validated proposal…</p></div>}
          </div>
          <div className="vlx-director-quick"><button type="button" onClick={() => setDirectorInput("Make the performance more restrained without changing the camera.")}>More restrained</button><button type="button" onClick={() => setDirectorInput("Strengthen continuity with the previous scene.")}>Improve continuity</button><button type="button" onClick={() => setDirectorInput("Remove music and preserve only explicitly requested ambience.")}>Refine sound</button></div>
          <label className="vlx-director-compose"><span className="sr-only">Message the Director</span><textarea value={directorInput} onChange={(event) => setDirectorInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendDirection(); } }} placeholder="Direct this scene in plain language…" /><button type="button" aria-label="Send direction" disabled={!directorInput.trim() || workspace.directorBusy} onClick={() => void sendDirection()}>Send</button></label>
          <small className="vlx-director-footnote">Gemma proposes. Video Lab validates. Nothing is overwritten without review.</small>
        </aside>
      </div>

      <nav className="vlx-filmstrip" aria-label="Storyboard scenes">
        <div className="vlx-filmstrip-label"><span>Scenes</span><small>{workspace.totalDuration}s total</small></div>
        <div className="vlx-scene-strip">{scenes.map((scene, index) => <button key={scene.id} type="button" className={selectedScene.id === scene.id ? "active" : ""} onClick={() => chooseScene(scene.id)}><span className={`vlx-strip-thumb scene-${(index % 4) + 1}`}><b>{index + 1}</b></span><span><strong>{scene.title}</strong><small>{scene.duration}s · {statusLabel(scene)}</small></span></button>)}<button type="button" className="vlx-add-scene" disabled={scenes.length >= Math.min(24, workspace.runtime?.capabilities?.maxScenes ?? 24)} onClick={() => workspace.resizeScenes(scenes.length + 1)}><span>+</span><b>Add scene</b></button></div>
      </nav>

      <nav className="vlx-mobile-nav" aria-label="Mobile workspace"><button type="button" className={mobilePane === "canvas" && activeStage === 0 ? "active" : ""} onClick={() => { setMobilePane("canvas"); setActiveStage(0); }}><span>01</span>Story</button><button type="button" className={mobilePane === "canvas" && activeStage !== 0 ? "active" : ""} onClick={() => { setMobilePane("canvas"); setActiveStage(2); }}><span>03</span>Scenes</button><button type="button" className={mobilePane === "assets" ? "active" : ""} onClick={() => { setMobilePane("assets"); setActiveStage(1); }}><span>02</span>Assets</button><button type="button" className={mobilePane === "director" ? "active" : ""} onClick={() => setMobilePane("director")}><span>G</span>Director</button></nav>
    </main>
  );
}

type StoryboardAudioPolicyMode = "silent" | "intent_only" | "directed";

function generatedTextPolicyForMode(
  current: StoryboardGeneratedTextPolicy,
  mode: StoryboardGeneratedTextPolicy["mode"],
): StoryboardGeneratedTextPolicy {
  return mode === "forbidden"
    ? defaultGeneratedTextPolicy()
    : { ...current, mode };
}

function TemporalKeyframeEditor({
  scene,
  maximum,
  onAdd,
  onChange,
}: {
  scene: StoryboardScenePayload;
  maximum: number;
  onAdd: (file: File) => Promise<void>;
  onChange: (keyframes: StoryboardTemporalKeyframePayload[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keyframes = [...(scene.keyframes ?? [])].sort(
    (left, right) => left.timeSeconds - right.timeSeconds,
  );
  const update = (
    id: string,
    patch: Partial<StoryboardTemporalKeyframePayload>,
  ) => {
    onChange(
      keyframes
        .map((keyframe) =>
          keyframe.id === id ? { ...keyframe, ...patch } : keyframe,
        )
        .sort((left, right) => left.timeSeconds - right.timeSeconds),
    );
  };
  return (
    <details className="vlx-keyframe-editor" open={keyframes.length > 0}>
      <summary>
        <span><small>Advanced visual control</small><b>Intermediate frame anchors</b></span>
        <em>{keyframes.length}/{maximum}</em>
      </summary>
      <p>Guide exact compositions between the approved first and last frames. Existing anchors are never retimed automatically.</p>
      <div className="vlx-keyframe-list">
        {keyframes.map((keyframe, index) => {
          const previous = keyframes[index - 1]?.timeSeconds ?? 0;
          const next = keyframes[index + 1]?.timeSeconds ?? scene.duration;
          return (
            <article key={keyframe.id}>
              <PrivateTemporalKeyframeArt keyframe={keyframe} index={index} />
              <div>
                <strong>Anchor {index + 1}</strong>
                <label>
                  <span>Time in scene</span>
                  <input
                    type="number"
                    min={Number((previous + 0.04).toFixed(2))}
                    max={Number((next - 0.04).toFixed(2))}
                    step={0.05}
                    value={keyframe.timeSeconds}
                    onChange={(event) => update(keyframe.id, {
                      timeSeconds: Math.min(
                        next - 0.04,
                        Math.max(previous + 0.04, Number(event.target.value)),
                      ),
                    })}
                  />
                  <small>seconds</small>
                </label>
                <label>
                  <span>Anchor strength</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={keyframe.strength}
                    onChange={(event) => update(keyframe.id, { strength: Number(event.target.value) })}
                  />
                  <small>{keyframe.strength.toFixed(2)}</small>
                </label>
              </div>
              <button
                type="button"
                className="vlx-secondary"
                onClick={() => onChange(keyframes.filter((candidate) => candidate.id !== keyframe.id))}
              >
                Remove
              </button>
            </article>
          );
        })}
      </div>
      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setBusy(true);
          setError("");
          void onAdd(file)
            .catch((caught) => setError(caught instanceof Error ? caught.message : "The frame anchor could not be added."))
            .finally(() => setBusy(false));
        }}
      />
      <button
        type="button"
        className="vlx-secondary"
        disabled={busy || keyframes.length >= maximum}
        onClick={() => input.current?.click()}
      >
        {busy ? "Uploadingâ€¦" : "Add intermediate frame"}
      </button>
      {error && <p className="vlx-error" role="alert">{error}</p>}
    </details>
  );
}

function PrivateTemporalKeyframeArt({
  keyframe,
  index,
}: {
  keyframe: StoryboardTemporalKeyframePayload;
  index: number;
}) {
  const localUrl = objectUrl(keyframe.frame);
  const [storedUrl, setStoredUrl] = useState<string>();
  useEffect(() => {
    if (keyframe.frame || !keyframe.frameAssetId) {
      setStoredUrl(undefined);
      return;
    }
    let active = true;
    let object: string | undefined;
    void fetchUserAsset(keyframe.frameAssetId)
      .then((blob) => {
        if (!active || !blob.type.startsWith("image/")) return;
        object = URL.createObjectURL(blob);
        setStoredUrl(object);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [keyframe.frame, keyframe.frameAssetId]);
  const url = localUrl ?? storedUrl;
  return url
    ? <img src={url} alt={`Private intermediate frame anchor ${index + 1}`} />
    : <div className="vlx-frame-empty">Private frame unavailable</div>;
}

function FrameCard({ edge, prompt, file, state, position, onPrompt, onRegenerate }: { edge: string; prompt: string; file?: File; state: WorkspaceFrameState; position: "first" | "last"; onPrompt: (value: string) => void; onRegenerate: () => void }) {
  const url = objectUrl(file);
  const [previewOpen, setPreviewOpen] = useState(false);
  const busy = state.status === "queued" || state.status === "generating";
  return <article className={`vlx-frame-card ${position}`}><div className={`vlx-frame-image ${url ? "can-preview" : ""}`} onDoubleClick={() => url && setPreviewOpen(true)} title={url ? "Double-click to preview" : undefined}>{url ? <img src={url} alt={`${edge} private preview`} /> : <div className="vlx-frame-empty">No approved frame yet</div>}<span>{busy ? "Replacement in progress" : edge}</span>{busy && <i className="vlx-frame-loading" />}</div><div className="vlx-frame-copy"><label><span>{edge} prompt · Z-Image Turbo</span><textarea value={prompt} onChange={(event) => onPrompt(event.target.value)} /></label><button type="button" disabled={busy || prompt.trim().length < 8} onClick={onRegenerate}>{busy ? state.status === "queued" ? "Queued…" : "Generating…" : file ? "Review regeneration" : "Review generation"}</button>{state.status === "failed" && <p className="vlx-error" role="alert">{state.error} The previous frame is unchanged.</p>}</div>{previewOpen && url && <div className="vlx-image-lightbox" role="dialog" aria-modal="true" aria-label={`${edge} preview`} onMouseDown={() => setPreviewOpen(false)}><button type="button" aria-label="Close image preview" onClick={() => setPreviewOpen(false)}>Close</button><img src={url} alt={`${edge} full preview`} onMouseDown={(event) => event.stopPropagation()} /></div>}</article>;
}

function DirectorReferenceEvidence({
  reference,
  sceneIds,
  evidence,
}: {
  reference: StoryboardProjectReference;
  sceneIds: string[];
  evidence: ReturnType<typeof useDirectorWorkspace>["form"]["referencePlanningEvidence"];
}) {
  if (!evidence) return <div className="vlx-reference-evidence muted"><b>Not analysed</b><small>Ask the Director to use this reference.</small></div>;
  const state = evidence.referenceStates.find((item) => item.referenceId === reference.id);
  const currentScope = reference.sceneIds.map((sceneId) => sceneIds.indexOf(sceneId) + 1).filter((number) => number > 0);
  const stale = !state || state.version !== reference.version || JSON.stringify(state.shotNumbers) !== JSON.stringify(currentScope);
  const analysis = evidence.visualReferenceAnalyses.find((item) => item.referenceId === reference.id);
  const status = stale
    ? "Stale analysis"
    : evidence.vision.attachedReferenceIds.includes(reference.id)
      ? "Visual used"
      : evidence.vision.textOnlyReferenceIds.includes(reference.id)
        ? "Text only"
        : "Not used";
  return (
    <div className={`vlx-reference-evidence ${stale ? "stale" : ""}`}>
      <b>{status}</b>
      {stale && <small>The media version or scene scope changed. Ask the Director again to refresh it.</small>}
      {!stale && analysis && (
        <>
          {analysis.observedTraits.length > 0 && <p>{analysis.observedTraits.join(" · ")}</p>}
          <small>{analysis.continuityGuidance}</small>
          {analysis.declaredVisibleConflicts.map((conflict) => <em key={conflict}>{conflict}</em>)}
        </>
      )}
    </div>
  );
}

function PrivateReferenceArt({ reference, hero = false }: { reference: StoryboardProjectReference; hero?: boolean }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!reference.assetId) return;
    let active = true;
    let object: string | undefined;
    void fetchUserAsset(reference.assetId).then((blob) => {
      if (!active || !blob.type.startsWith("image/")) return;
      object = URL.createObjectURL(blob);
      setUrl(object);
    }).catch(() => undefined);
    return () => { active = false; if (object) URL.revokeObjectURL(object); };
  }, [reference.assetId]);
  if (hero) return <div className={`vlx-reference-hero ${reference.type}`}>{url ? <img src={url} alt={`${reference.label} private reference`} /> : <i />}<span>{reference.type}</span></div>;
  return <span className={`vlx-reference-art ${reference.type}`}>{url ? <img src={url} alt="" /> : <i />}</span>;
}

function CandidateGrid({ scene, onAccept }: { scene: StoryboardScenePayload; onAccept: (generationId: string) => void }) {
  const ids = scene.candidateGenerationIds ?? [];
  const results = useQueries({ queries: ids.map((id) => ({ queryKey: ["director-candidate", id], queryFn: () => getGeneration(id) })) });
  const ranked = ids.map((id, index) => ({ id, index, generation: results[index]?.data })).sort((left, right) => (right.generation?.qualityAssessment?.score ?? -1) - (left.generation?.qualityAssessment?.score ?? -1) || left.index - right.index);
  if (!ids.length) return <div className="vlx-empty-state"><h3>No drafts yet</h3><p>Ask the Director to prepare a bounded draft-generation request. No media is simulated here.</p></div>;
  return <div className="vlx-candidate-grid">{ranked.map((candidate, rank) => <CandidateCard key={candidate.id} generationId={candidate.id} initial={candidate.generation} label={`Draft ${candidate.index + 1}`} rank={rank + 1} accepted={scene.acceptedVideoGenerationId === candidate.id} onAccept={() => onAccept(candidate.id)} />)}</div>;
}

function CandidateCard({ generationId, initial, label, rank, accepted, onAccept }: { generationId: string; initial?: Generation; label: string; rank: number; accepted: boolean; onAccept: () => void }) {
  const generation = useQuery({ queryKey: ["director-candidate-detail", generationId], queryFn: () => getGeneration(generationId), initialData: initial });
  const data = generation.data;
  const issues = data?.qualityAssessment?.checks.filter((check) => check.status === "failed" || check.status === "warning") ?? [];
  return <article className={accepted ? "accepted" : ""}><div className="vlx-candidate-media">{data?.status === "completed" && data.output?.downloadUrl ? <AuthenticatedVideo downloadUrl={data.output.downloadUrl} /> : <span>{data?.status ?? "Loading"}</span>}{accepted && <span>Selected</span>}</div><header><h3>{label}</h3><small>{data?.qualityAssessment ? `Technical rank ${rank}` : "Technical review unavailable"}</small></header><div className="vlx-quality-flags">{data?.qualityAssessment ? <><span>Integrity {data.qualityAssessment.score}/100</span><span className={issues.length ? "warn" : "good"}>{issues.length ? `${issues.length} technical warnings` : "No reported integrity issues"}</span></> : <span>Semantic quality not evaluated</span>}</div><p>{issues.length ? issues.map((issue) => issue.detail || issue.id).join(" ") : "Review the creative result yourself; automated checks do not judge identity or prompt adherence."}</p><footer><button type="button" className="vlx-secondary" disabled title="Retake and repair are unavailable until a verified runtime workflow exists.">Repair unavailable</button><button type="button" disabled={accepted || data?.status !== "completed"} onClick={onAccept}>{accepted ? "Selected" : "Select draft"}</button></footer></article>;
}

function ProposalCard({ proposal, busy, onAccept, onEdit, onDiscard }: { proposal: DirectorProposal; busy: boolean; onAccept: () => void; onEdit: () => void; onDiscard: () => void }) {
  if (proposal.state !== "pending") return <div className={`vlx-proposal-state ${proposal.state}`}>{proposal.state === "accepted" ? "Accepted" : "Discarded"}</div>;
  if (proposal.kind === "answer" || proposal.kind === "suggestion") return null;
  return <section className="vlx-proposal"><header><strong>{proposal.summary}</strong><span>{proposal.executionClass === "none" ? "No inference" : proposal.executionClass === "text" ? "Text only" : proposal.executionClass === "draft" ? "Draft inference" : "Final operation"}</span></header>{proposal.diff.map((change) => <div className="vlx-diff" key={change.path}><small>{change.label}</small>{change.before !== undefined && <p><b>Before</b>{change.before || "Empty"}</p>}{change.after !== undefined && <p><b>After</b>{change.after || "Empty"}</p>}</div>)}{!!proposal.preserve.length && <p className="vlx-preserve"><b>Preserves:</b> {proposal.preserve.join(", ")}</p>}{!!proposal.invalidations.length && <p className="vlx-invalidation"><b>Will need review:</b> {proposal.invalidations.join(" ")}</p>}{proposal.executionClass === "draft" || proposal.executionClass === "final" ? <p className="vlx-estimate">A reliable time or cost estimate is unavailable until the connected runtime reports one.</p> : null}<div className="vlx-suggestion-actions"><button type="button" disabled={busy} onClick={onAccept}>{proposal.confirmationRequired ? "Confirm and continue" : "Accept"}</button><button type="button" disabled={busy} onClick={onEdit}>Edit</button><button type="button" disabled={busy} onClick={onDiscard}>Discard</button></div></section>;
}
