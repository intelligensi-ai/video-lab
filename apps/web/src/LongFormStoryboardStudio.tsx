import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_STORYBOARD_SCENES } from '@video-lab/contracts';
import type { Generation } from '@video-lab/contracts';
import { cancelGeneration, generateLongFormVideo, getGallery, getGeneration, getRuntimeStatus, type LongFormGenerationPayload, type ReferenceRole, type StoryboardScenePayload, type StoryboardTransition } from './api.js';
import { useAuthenticatedVideo } from './AuthenticatedVideo.js';
import { PromptSuggestion } from './PromptSuggestion.js';
import { getFirebaseUser, isProductionFirebase } from './auth.js';
import { loadStoryboardSession, saveStoryboardSession } from './storyboardSession.js';

type LongFormReference = { label: string; role: ReferenceRole; file?: File; preview?: string; strength: number; helper: string };

const initialReferences: LongFormReference[] = [
  { label: 'Reference image', role: 'referenceImage', strength: .6, helper: 'Guide composition, environment, props and overall visual content.' },
  { label: 'Reference character(s)', role: 'subjectReference', strength: .65, helper: 'Keep the principal character identity and appearance consistent between scenes.' },
  { label: 'Style images', role: 'styleReference', strength: .5, helper: 'Guide palette, lighting, texture and cinematography across the film.' },
];

const transitionOptions: Array<{ value: StoryboardTransition; label: string; description: string; glyph: string }> = [
  { value: 'cut', label: 'Cut', description: 'Immediate editorial cut', glyph: '┃' },
  { value: 'crossfade', label: 'Cross fade', description: 'Blend both scenes together', glyph: '◩' },
  { value: 'fade_black', label: 'Fade through black', description: 'Cinematic passage of time', glyph: '◐' },
  { value: 'fade_white', label: 'Fade through white', description: 'Bright flash transition', glyph: '◑' },
  { value: 'slide_left', label: 'Slide left', description: 'Next scene pushes left', glyph: '←' },
  { value: 'slide_right', label: 'Slide right', description: 'Next scene pushes right', glyph: '→' },
  { value: 'wipe_left', label: 'Wipe left', description: 'Hard edge sweeps left', glyph: '◧' },
  { value: 'wipe_right', label: 'Wipe right', description: 'Hard edge sweeps right', glyph: '◨' },
  { value: 'zoom_warp', label: 'Zoom warp', description: 'Fast lens push between shots', glyph: '◎' },
  { value: 'radial', label: 'Radial reveal', description: 'Circular iris transition', glyph: '◉' },
  { value: 'blur_dissolve', label: 'Blur dissolve', description: 'Soft defocus and resolve', glyph: '✣' },
];

const initialScenes: StoryboardScenePayload[] = [
  { id: 'scene-1', title: 'Scene 1', prompt: '', duration: 5, trimStart: 0, trimEnd: 5, seed: 1337, transition: 'cut', transitionDuration: 0.75, carryPreviousFrame: true },
  { id: 'scene-2', title: 'Scene 2', prompt: '', duration: 5, trimStart: 0, trimEnd: 5, seed: 1338, transition: 'crossfade', transitionDuration: 0.75, carryPreviousFrame: true },
];

const initialForm: LongFormGenerationPayload = {
  overallGoal: '',
  negativePrompt: '',
  resolution: '1280x720', fps: 24, imageSteps: 4, guidanceScale: 1, startFrameStrength: 1, endFrameStrength: .85,
  enhancePrompt: true, postProcess: 'none', outputFormat: 'mp4', seedMode: 'sequence', baseSeed: 1337,
  globalVisualAnchorEnabled: false, scenes: initialScenes,
  references: initialReferences,
};

export default function LongFormStoryboardStudio() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(initialForm);
  const [history, setHistory] = useState<Generation[]>([]);
  const [selected, setSelected] = useState<Generation>();
  const [sceneCount, setSceneCount] = useState(2);
  const [helpMode, setHelpMode] = useState(false);
  const [sessionOwner, setSessionOwner] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading');
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: getRuntimeStatus });
  const gallery = useQuery({ queryKey: ['gallery'], queryFn: getGallery });
  const mutation = useMutation({ mutationFn: () => generateLongFormVideo(form), onSuccess: (generation) => { setSelected(generation); setHistory((items) => [generation, ...items].slice(0, 8)); } });
  useEffect(() => {
    const items = gallery.data?.items ?? [];
    setHistory(items.slice(0, 8));
    if (!selected) setSelected(items.find((item) => !['completed', 'failed', 'cancelled'].includes(item.status)));
  }, [gallery.data, selected]);
  useEffect(() => {
    setSceneCount(form.scenes.length);
  }, [form.scenes.length]);
  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        const owner = isProductionFirebase ? (await getFirebaseUser()).uid : (localStorage.getItem('vl_token') || 'demo-user');
        const saved = await loadStoryboardSession(owner);
        if (!active) return;
        setSessionOwner(owner);
        if (saved) {
          setForm({
            ...initialForm,
            ...saved,
            scenes: saved.scenes?.length
              ? saved.scenes.slice(0, MAX_STORYBOARD_SCENES).map((scene) => ({
                  ...scene,
                  trimStart: 0,
                  trimEnd: scene.duration,
                }))
              : initialScenes,
            references: saved.references?.length ? saved.references : initialReferences,
          });
        }
        setSessionReady(true);
        setSessionStatus('saved');
      } catch {
        if (!active) return;
        setSessionReady(true);
        setSessionStatus('error');
      }
    };
    void restore();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!sessionReady || !sessionOwner) return;
    setSessionStatus('saving');
    const timer = window.setTimeout(() => {
      void saveStoryboardSession(sessionOwner, form)
        .then(() => setSessionStatus('saved'))
        .catch(() => setSessionStatus('error'));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [form, sessionOwner, sessionReady]);
  const generation = useQuery({
    queryKey: ['generation', selected?.id],
    queryFn: () => getGeneration(selected!.id),
    enabled: Boolean(selected?.id),
    refetchInterval: (query) => {
      const current = query.state.data as Generation | undefined;
      return current && ['completed', 'failed', 'cancelled'].includes(current.status) ? false : 2000;
    },
  });
  const currentGeneration = generation.data ?? selected;
  const isRendering = mutation.isPending || Boolean(currentGeneration && !['completed', 'failed', 'cancelled'].includes(currentGeneration.status));
  const cancellation = useMutation({
    mutationFn: () => cancelGeneration(currentGeneration!.id),
    onSuccess: (cancelled) => {
      setSelected(cancelled);
      setHistory((items) => items.map((item) => item.id === cancelled.id ? cancelled : item));
      void queryClient.invalidateQueries({ queryKey: ['gallery'] });
      void queryClient.invalidateQueries({ queryKey: ['generation', cancelled.id] });
    },
  });
  const totalSeconds = useMemo(() => form.scenes.reduce((sum, scene) => sum + scene.duration, 0), [form.scenes]);
  const updateScene = (index: number, patch: Partial<StoryboardScenePayload>) => setForm((current) => ({ ...current, scenes: current.scenes.map((scene, i) => i === index ? { ...scene, ...patch } : scene) }));
  const moveScene = (index: number, direction: -1 | 1) => setForm((current) => { const target = index + direction; if (target < 0 || target >= current.scenes.length) return current; const scenes = [...current.scenes]; [scenes[index], scenes[target]] = [scenes[target], scenes[index]]; return { ...current, scenes }; });
  const addScene = () => setForm((current) => current.scenes.length >= MAX_STORYBOARD_SCENES ? current : ({ ...current, scenes: [...current.scenes, { id: crypto.randomUUID(), title: `Scene ${current.scenes.length + 1}`, prompt: '', duration: 5, trimStart: 0, trimEnd: 5, seed: current.baseSeed + current.scenes.length, transition: 'crossfade', transitionDuration: .75, carryPreviousFrame: true }] }));
  const removeScene = (index: number) => setForm((current) => current.scenes.length <= 1 ? current : ({ ...current, scenes: current.scenes.filter((_, i) => i !== index) }));
  const planScenes = () => {
    const count = Math.max(1, Math.min(MAX_STORYBOARD_SCENES, sceneCount));
    const beats = ['Opening image', 'The journey begins', 'A new obstacle', 'Discovery', 'Turning point', 'Final reveal'];
    setForm((current) => ({ ...current, scenes: Array.from({ length: count }, (_, index) => ({ id: crypto.randomUUID(), title: beats[index] ?? `Scene ${index + 1}`, prompt: `${index === 0 ? 'Establish' : 'Continue from the previous final frame and develop'} the artistic goal: ${current.overallGoal} Scene ${index + 1} of ${count}; describe one clear action, camera beat, lighting progression, and final composition.`, duration: 5, trimStart: 0, trimEnd: 5, seed: current.baseSeed + index, transition: index === 0 ? 'cut' : 'crossfade', transitionDuration: .75, carryPreviousFrame: true })) }));
  };
  const invalid = !form.overallGoal.trim() || !form.scenes.length || form.scenes.some((scene) => !scene.prompt.trim());

  return <main className={`lf-page ${helpMode ? 'help-mode' : ''}`}>
    <header className="lf-hero">
      <div><div className="lf-kickers"><span data-help="The generation service is connected and ready to accept a storyboard film.">Generator ready</span><span data-help="Z-Image creates still frame anchors; LTX turns each planned scene into motion and joins the clips into one film.">Z-Image + LTX Storyboard</span><span className={`lf-session-save ${sessionStatus}`} data-help="Your brief, prompts, titles, settings and uploaded frame images are automatically preserved in this browser.">{sessionStatus === 'loading' ? 'Loading session' : sessionStatus === 'saving' ? 'Saving session' : sessionStatus === 'error' ? 'Session save unavailable' : 'Session saved'}</span><button type="button" className="lf-help-toggle" aria-pressed={helpMode} onClick={() => setHelpMode((enabled) => !enabled)} data-help="Turn contextual explanations off.">{helpMode ? '✦ Help on' : '? Help'}</button></div><h1 className="editorial-page-title lf-storyboard-title">Storyboard Studio<span className="editorial-title-stop">.</span></h1><p>Direct a longer film scene by scene. Upload frame anchors where they matter; otherwise the runtime generates the opening and carries each real final frame into the next clip.</p></div>
      <div className="lf-session"><span data-help="Shows whether the remote video-generation runtime is available.">{runtime.data?.status ?? 'checking'} runtime</span><strong data-help="Storyboard sessions and generated films remain private to your signed-in account.">Private session</strong><Link to="/gallery" data-help="Open all previously generated films and their details.">Gallery</Link></div>
    </header>
    <div className="lf-layout"><div className="lf-controls">
      <section className="lf-panel lf-goal"><span className="lf-label">Creative brief</span><div className="prompt-field-heading"><h2>What is the whole film about?</h2><PromptSuggestion value={form.overallGoal} suggestion="An ancient epic follows a battle-worn voyager across a mythic sea as he struggles to return to his family, while those at home defend a fragile kingdom and their faith in his survival." expansion="Expand this into a coherent film brief with a clear narrative progression, consistent characters and locations, a defined visual palette, lighting and lens language, material detail, emotional tone and continuity rules for every scene." kind="film-brief" onUse={(suggestion) => setForm((current) => ({ ...current, overallGoal: suggestion }))}/></div><div className="lf-help-target" data-help="The master brief for the entire film: story progression, recurring characters, locations, palette, lens language and continuity rules."><textarea aria-label="Overall artistic goal" value={form.overallGoal} placeholder="Describe the story, subject, visual language and continuity for the whole film…" onChange={(event) => setForm((current) => ({ ...current, overallGoal: event.target.value }))}/></div><p>Set the visual and narrative rules for the whole film. Each scene then contributes one clear action and camera beat.</p></section>
      <section className="lf-panel lf-storyboard-settings"><span className="lf-label">Setup</span><h2>Storyboard settings</h2><div className="lf-settings"><Field label="Working resolution" help="Sets the frame dimensions. Draft sizes render faster; HD sizes contain more detail and require more processing."><select value={form.resolution} onChange={(event) => setForm((current) => ({ ...current, resolution: event.target.value }))}><option value="1024x576">Landscape Draft 1024x576</option><option value="1280x720">Landscape HD 1280x720</option><option value="576x1024">Phone Draft 576x1024</option><option value="720x1280">Phone HD 720x1280</option><option value="1080x1080">Square 1080x1080</option></select></Field><Field label="Frame rate" help="Frames shown per second. 24 fps feels cinematic; 25 fps suits PAL delivery; 30 fps feels slightly smoother."><select value={form.fps} onChange={(event) => setForm((current) => ({ ...current, fps: Number(event.target.value) }))}><option value={24}>24 fps</option><option value={25}>25 fps</option><option value={30}>30 fps</option></select></Field></div><div className="lf-plan"><label data-help="Choose how many scene cards the automatic planner should create, from 1 to 6."><span className="lf-label">AI scenes</span><input type="number" min={1} max={MAX_STORYBOARD_SCENES} value={sceneCount} onChange={(event) => setSceneCount(Math.max(1, Math.min(MAX_STORYBOARD_SCENES, Number(event.target.value))))}/></label><button type="button" className="lf-outline" data-help="Build up to six scene cards from the creative brief. You can rewrite and reorder every scene afterwards." onClick={planScenes}>✣ Plan scenes</button><div className="lf-count" data-help="Shows the number of planned scenes and their combined running time."><strong>{form.scenes.length}/{MAX_STORYBOARD_SCENES}</strong> scenes<br/><strong>{Math.floor(totalSeconds / 60)}:{String(Math.round(totalSeconds % 60)).padStart(2, '0')}</strong> requested</div></div></section>
      <section className="lf-scenes"><div className="lf-section-head"><div><span className="lf-label">Timeline</span><h2>Storyboard scenes</h2></div><button type="button" className="lf-primary lf-add" data-help="Append a new editable scene card, up to the six-scene GPU-safe limit." disabled={form.scenes.length >= MAX_STORYBOARD_SCENES} onClick={addScene}>＋ Add scene</button></div>{form.scenes.map((scene, index) => <SceneCard key={scene.id} scene={scene} index={index} count={form.scenes.length} onChange={(patch) => updateScene(index, patch)} onMove={(direction) => moveScene(index, direction)} onRemove={() => removeScene(index)}/>)}</section>
      <section className="lf-panel lf-bible lf-storyboard-setup"><span className="lf-label">Film Bible</span><h2>Continuity and reproducibility</h2><p>Keep visual guidance and reproducibility together for the complete storyboard.</p><LongFormReferencePanel references={form.references as LongFormReference[]} onChange={(references) => setForm((current) => ({ ...current, references }))}/><div className="lf-bible-grid"><Field label="Randomiser strategy" help="Stable sequence increments one base number across scenes; Per scene keeps each scene's own number; Random takes varies results on each generation."><select value={form.seedMode} onChange={(event) => setForm((current) => ({ ...current, seedMode: event.target.value }))}><option value="sequence">Stable sequence</option><option value="per_scene">Per scene</option><option value="random">Random takes</option></select></Field><Field label="Randomiser" help="The base random number used to reproduce a visual result. Reusing it helps keep future takes comparable."><input type="number" value={form.baseSeed} onChange={(event) => setForm((current) => ({ ...current, baseSeed: Number(event.target.value) }))}/></Field><UploadBox label="Global visual anchor" help="Optional fallback image for the opening visual when a scene has no dedicated start frame." compact file={form.globalVisualAnchor} onFile={(file) => setForm((current) => ({ ...current, globalVisualAnchor: file }))}/><label className="lf-toggle" data-help="Allow the global visual anchor to be used when a scene does not supply its own start frame."><input type="checkbox" checked={form.globalVisualAnchorEnabled} onChange={(event) => setForm((current) => ({ ...current, globalVisualAnchorEnabled: event.target.checked }))}/><span/> Enable anchor fallback</label></div></section>
      <details className="lf-panel lf-production"><summary><span><span className="lf-label">Advanced</span><h2>Production settings</h2></span><span className="lf-production-toggle" aria-hidden="true">＋</span></summary><div className="lf-production-content"><div className="lf-settings"><Range label="Opening frame steps" help="How much generation work Z-Image spends resolving an opening frame. Higher values can add detail but take longer." value={form.imageSteps} min={1} max={12} step={1} onChange={(value) => setForm((current) => ({ ...current, imageSteps: value }))}/><Range label="LTX guidance" help="How strongly LTX follows the written scene direction. Higher is more literal; lower allows more visual interpretation." value={form.guidanceScale} min={0} max={8} step={.25} onChange={(value) => setForm((current) => ({ ...current, guidanceScale: value }))}/><Range label="Start frame strength" help="How closely the beginning of each generated clip follows its supplied or inherited start frame." value={form.startFrameStrength} min={0} max={1} step={.05} onChange={(value) => setForm((current) => ({ ...current, startFrameStrength: value }))}/><Range label="End frame strength" help="How closely the final part of a clip aims toward a supplied end frame. Lower values permit freer motion." value={form.endFrameStrength} min={0} max={1} step={.05} onChange={(value) => setForm((current) => ({ ...current, endFrameStrength: value }))}/><Field label="Enhance scene prompts" help="Lets the runtime enrich short scene directions with production detail before generating the clips."><select value={form.enhancePrompt ? 'yes' : 'no'} onChange={(event) => setForm((current) => ({ ...current, enhancePrompt: event.target.value === 'yes' }))}><option value="yes">Enabled</option><option value="no">Disabled</option></select></Field><Field label="Finishing pass" help="None is fastest; Interpolate smooths motion; Upscale increases output size; Both performs both finishing operations."><select value={form.postProcess} onChange={(event) => setForm((current) => ({ ...current, postProcess: event.target.value }))}><option value="none">None - fastest draft</option><option value="interpolate">Interpolate motion</option><option value="upscale">Upscale 2x</option><option value="both">Interpolate + upscale</option></select></Field><Field label="Output format" help="MP4 has the broadest playback compatibility; WebM is a modern web-focused container."><select value={form.outputFormat} onChange={(event) => setForm((current) => ({ ...current, outputFormat: event.target.value }))}><option value="mp4">MP4</option><option value="webm">WebM</option></select></Field></div><div className="lf-field prompt-field" data-help="List unwanted artefacts or visual behaviour once here; it will be applied consistently to every scene."><div className="prompt-field-heading"><span className="lf-label">Shared negative prompt</span><PromptSuggestion value={form.negativePrompt} suggestion="Avoid low quality, blurry frames, jittery motion, warped anatomy, duplicate subjects, identity drift, discontinuous lighting, unreadable text, watermarks and abrupt cuts." expansion="Also exclude compression artefacts, unstable motion, inconsistent identity or wardrobe, continuity breaks, unwanted text, lighting shifts and anything that conflicts with the film's visual language." kind="negative" onUse={(suggestion) => setForm((current) => ({ ...current, negativePrompt: suggestion }))}/></div><textarea className="lf-negative" aria-label="Shared negative prompt" value={form.negativePrompt} placeholder="Describe unwanted styles, artefacts or continuity problems…" onChange={(event) => setForm((current) => ({ ...current, negativePrompt: event.target.value }))}/></div></div></details><button type="button" data-help="Validate the brief and scenes, then submit the complete storyboard to the video-generation queue." disabled={mutation.isPending || invalid} className="lf-primary lf-generate" onClick={() => mutation.mutate()}>{mutation.isPending ? '◌ Rendering storyboard...' : 'ϟ Generate Storyboard Film'}</button>{mutation.error && <div className="lf-error">{mutation.error.message}</div>}
    </div><aside className="lf-preview-col"><Preview generation={currentGeneration} loading={isRendering} cancelling={cancellation.isPending} onCancel={() => cancellation.mutate()} cancelError={cancellation.error?.message}/><History generations={history} onSelect={setSelected}/></aside></div>
  </main>;
}

function Field({ label, help, children }: { label: string; help?: string; children?: React.ReactNode }) { return <label className="lf-field" data-help={help}><span className="lf-label">{label}</span>{children}</label>; }
function Range({ label, help, value, min, max, step, onChange }: { label: string; help?: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) { return <Field label={label} help={help}><div className="lf-range"><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))}/><output>{value}</output></div></Field>; }

function LongFormReferencePanel({ references, onChange }: { references: LongFormReference[]; onChange: (references: LongFormReference[]) => void }) {
  const [open, setOpen] = useState(false);
  const selectedCount = references.filter((reference) => reference.file).length;
  const updateReference = (index: number, next: LongFormReference) => onChange(references.map((reference, referenceIndex) => referenceIndex === index ? next : reference));
  return <section className={`lf-reference-panel ${open ? 'open' : ''}`}>
    <button type="button" className="lf-reference-summary" data-help="Open optional image guidance for composition, recurring character identity and the film's overall visual style." aria-expanded={open} onClick={() => setOpen((value) => !value)}><span className="lf-reference-icon">▧</span><span><strong>Reference images, characters and style</strong><small>Optional visual guidance · {selectedCount ? `${selectedCount} selected` : 'collapsed'}</small></span><span className="lf-reference-chips"><i>Reference image</i><i>Character(s)</i><i>Style</i></span><b>{open ? '⌃' : '⌄'}</b></button>
    {open && <div className="lf-reference-grid">{references.map((reference, index) => <ReferenceCard key={reference.role} reference={reference} onChange={(next) => updateReference(index, next)}/>)}</div>}
  </section>;
}

function ReferenceCard({ reference, onChange }: { reference: LongFormReference; onChange: (reference: LongFormReference) => void }) {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!reference.file) {
      setPreview('');
      return;
    }
    const objectUrl = URL.createObjectURL(reference.file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [reference.file]);
  return <article className={`lf-reference-card ${reference.file ? 'has-file' : ''}`}><div className="lf-reference-card-head"><strong>{reference.label}</strong>{reference.file && <button type="button" data-help={`Remove the current ${reference.label.toLowerCase()} from this storyboard.`} onClick={() => onChange({ ...reference, file: undefined, preview: undefined })}>Remove</button>}</div><label className="lf-reference-preview" data-help={reference.helper}>{preview ? <img src={preview} alt={`${reference.label} preview`}/> : <><span>▧</span><b>Upload image</b><small>PNG, JPEG or WebP</small></>}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onChange({ ...reference, file, preview: undefined }); }}/></label><p>{reference.helper}</p><label className="lf-reference-strength" data-help="Controls how strongly this image influences generation. Lower values are suggestive; higher values follow it more closely."><span>Strength <b>{reference.strength.toFixed(2)}</b></span><input type="range" min={0} max={1} step={.05} value={reference.strength} onChange={(event) => onChange({ ...reference, strength: Number(event.target.value) })}/></label>{reference.file && <small className="lf-reference-filename">{reference.file.name}</small>}</article>;
}

function SceneCard({ scene, index, count, onChange, onMove, onRemove }: { scene: StoryboardScenePayload; index: number; count: number; onChange: (patch: Partial<StoryboardScenePayload>) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedTransition = transitionOptions.find((option) => option.value === scene.transition) ?? transitionOptions[0];
  const suggestion = index === 0 ? 'Wide street-level tracking shot. The founder notices a thin teal reflection moving through puddles. Keep the face and trench coat consistent; slow handheld pursuit; cool rain and warm shop windows.' : 'Begin from the previous final frame. The signal climbs a bridge rail as the camera arcs around the founder, revealing the skyline. Preserve direction of travel, identity, wet materials and the restrained teal-and-amber palette.';
  return <article className="lf-scene"><header><span className="lf-scene-number">{index + 1}</span><span className="lf-help-target lf-scene-title-help" data-help="A short editorial name used to identify this scene in the timeline."><input aria-label={`Scene ${index + 1} title`} value={scene.title} onChange={(event) => onChange({ title: event.target.value })}/></span><button data-help="Move this scene one position earlier in the film." disabled={index === 0} title="Move scene up" onClick={() => onMove(-1)}>↑</button><button data-help="Move this scene one position later in the film." disabled={index === count - 1} title="Move scene down" onClick={() => onMove(1)}>↓</button><PromptSuggestion label={scene.prompt.trim() ? `Expand scene ${index + 1}` : `Show a suggestion for scene ${index + 1}`} value={scene.prompt} suggestion={suggestion} expansion="Develop this scene with one precise subject action, motivated camera movement, lens and framing, lighting progression, continuity from the previous frame and a deliberate final composition that leads into the next scene." kind="storyboard-scene" onUse={(value) => onChange({ prompt: value })}/><button className="lf-delete" aria-label={`Delete scene ${index + 1}`} data-help="Permanently remove this scene from the storyboard." disabled={count <= 1} title="Delete scene" onClick={onRemove}><span aria-hidden="true">🗑</span> Delete</button></header><div className="prompt-field scene-prompt-field" data-help="Describe one story beat: subject action, camera movement, lighting change and the final frame that leads into the following scene."><div className="prompt-field-heading"><span className="lf-label">Scene direction</span></div><textarea aria-label={`Scene ${index + 1} direction`} value={scene.prompt} placeholder="Describe one clear action, camera movement, lighting beat and final composition…" onChange={(event) => onChange({ prompt: event.target.value })}/></div><div className="lf-scene-fields"><NumberField label="Duration" help="The full generated and delivered length of this scene." value={scene.duration} min={1} max={8} step={1} onChange={(value) => onChange({ duration: value, trimStart: 0, trimEnd: value })}/><NumberField label="Randomiser" help="This scene's reproducible random number. Change it to explore a different visual take of the same direction." value={scene.seed} min={0} max={999999999} step={1} onChange={(value) => onChange({ seed: value })}/>{index === 0 ? <Field label="Transition in" help="The first scene opens the film, so it has no incoming transition."><div className="lf-disabled">Opening scene</div></Field> : <Field label="Transition in" help="Choose how the previous scene blends or cuts into this one."><button className="lf-transition-button" onClick={() => setPickerOpen(true)}><b>{selectedTransition.glyph}</b><span>{selectedTransition.label}</span><i>›</i></button></Field>}</div><div className="lf-frames"><UploadBox label="Start frame" help="Optional exact visual anchor for the first frame of this scene. Without one, the previous clip's final frame can carry forward." file={scene.startFrame} onFile={(file) => onChange({ startFrame: file })}/><UploadBox label="End frame" help="Optional target composition for the final frame, useful when the next scene must begin from a precise image." file={scene.endFrame} onFile={(file) => onChange({ endFrame: file })}/></div>{pickerOpen && <TransitionPicker scene={scene} onChange={onChange} onClose={() => setPickerOpen(false)}/>}</article>;
}

function NumberField({ label, help, value, min, max, step, onChange }: { label: string; help?: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) { return <Field label={label} help={help}><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))}/></Field>; }
function UploadBox({ label, help, compact = false, file, onFile }: { label: string; help?: string; compact?: boolean; file?: File; onFile: (file?: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const acceptFile = (candidate?: File) => {
    if (candidate && ['image/jpeg', 'image/png', 'image/webp'].includes(candidate.type)) onFile(candidate);
  };
  return <div
    className={`lf-upload ${compact ? 'compact' : ''} ${file ? 'has-file' : ''} ${dragging ? 'is-dragging' : ''}`}
    data-help={help}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files?.[0]); }}
  >
    <button type="button" className="lf-upload-drop" aria-label={`${file ? 'Replace' : 'Add'} ${label.toLowerCase()}`} onClick={() => inputRef.current?.click()}>
      {preview && !compact ? <img src={preview} alt={`${label} preview`}/> : <span aria-hidden="true">▧</span>}
      <span className="lf-upload-copy"><strong>{label}</strong><small>{file?.name ?? 'Drag and drop an image, or click to browse'}</small></span>
      <i>{file ? 'Replace' : '+'}</i>
    </button>
    <input ref={inputRef} className="lf-upload-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { acceptFile(event.target.files?.[0]); event.currentTarget.value = ''; }}/>
    {file && <button type="button" className="lf-upload-remove" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => onFile(undefined)}>Remove</button>}
  </div>;
}
function TransitionPicker({ scene, onChange, onClose }: { scene: StoryboardScenePayload; onChange: (patch: Partial<StoryboardScenePayload>) => void; onClose: () => void }) { return <div className="lf-modal-backdrop" role="presentation" onMouseDown={onClose}><section className="lf-transition-modal" role="dialog" aria-modal="true" aria-label="Choose transition" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="lf-label">Video editor</span><h2>Choose transition</h2></div><button data-help="Close the transition chooser." onClick={onClose}>×</button></header><div className="lf-transition-grid">{transitionOptions.map((option) => <button key={option.value} data-help={`${option.description}. Select this as the incoming transition for the scene.`} className={scene.transition === option.value ? 'selected' : ''} onClick={() => onChange({ transition: option.value })}><span className="lf-transition-glyph">{option.glyph}</span><strong>{option.label}</strong><small>{option.description}</small></button>)}</div><footer><div><span className="lf-label">Duration</span><strong>{scene.transition === 'cut' ? '0.00' : scene.transitionDuration.toFixed(2)}s</strong></div><span className="lf-help-target" data-help="Controls how long the two clips overlap during the selected transition."><input aria-label="Transition duration" type="range" min={.25} max={2} step={.05} disabled={scene.transition === 'cut'} value={scene.transitionDuration} onChange={(event) => onChange({ transitionDuration: Number(event.target.value) })}/></span><button className="lf-primary" data-help="Keep the selected transition and return to the scene card." onClick={onClose}>Apply</button><p>Video and audio overlap together. The final film becomes shorter by the selected transition duration.</p></footer></section></div>; }

function Preview({ generation, loading, cancelling, onCancel, cancelError }: { generation?: Generation; loading: boolean; cancelling: boolean; onCancel: () => void; cancelError?: string }) { const video=useAuthenticatedVideo(generation?.output?.downloadUrl); return <section className="lf-preview lf-panel"><header><div><span className="lf-label">Your creation</span><h2>Cinematic preview</h2><p>Intelligensi.ai Storyboard Studio</p></div><span className="lf-complete" data-help="The current state of the selected generation: ready, queued, rendering, completed, failed or cancelled.">{loading ? 'Rendering' : generation?.status ?? 'Ready'}</span></header><div className="lf-preview-tabs"><span data-help="Your creative brief and individual scene directions form the generation plan.">ϟ <b>Create</b><small>Studio prompt</small></span><span data-help="LTX converts the planned scenes and frame anchors into moving video clips.">▣ <b>Render</b><small>LTX video</small></span><span data-help="Your generation session and resulting film remain associated with your private account.">♢ <b>Privacy</b><small>Private session</small></span></div><div className="lf-screen" data-help="The selected generated film appears here. While empty, this shows the Storyboard preview artwork.">{video.objectUrl ? <video src={video.objectUrl} controls/> : generation?.output?.downloadUrl ? <div className="thumb big">Retrieving completed video…</div> : <img src="/images/longform-ltx-storyboard-studio-film-roll.webp" alt="Film roll containing a sequence of cinematic storyboard frames"/>}{loading && <div className="lf-rendering">Rendering storyboard film…</div>}</div>{loading && generation && <button type="button" className="lf-cancel" data-help="Ask the generation service to stop the currently active storyboard render." disabled={cancelling} onClick={onCancel}>{cancelling ? 'Cancelling…' : 'Cancel active render'}</button>}{cancelError && <p className="lf-error">{cancelError}</p>}{video.error && <p className="error">Video retrieval failed: {video.error}</p>}{video.objectUrl && <a className="lf-download" data-help="Save the completed film file to your device." href={video.objectUrl} download={`${generation?.id ?? 'video'}.mp4`}>⇩ Download video</a>}<p className="lf-ready">{generation ? `Generated video ${generation.status}` : 'Your generated film will appear here'}</p><div className="lf-stats"><span data-help="Shows whether the selected film is waiting, rendering or complete."><b>⌁ Progress</b>{generation?.status === 'completed' ? '100%' : loading ? 'In queue' : '—'}</span><span data-help="Timing information for the selected generation session."><b>◷ Elapsed</b>Session</span><span data-help="Generated films remain associated with your private account."><b>♢ Access</b>Private</span></div><div className="lf-progress"/></section>; }
function History({ generations, onSelect }: { generations: Generation[]; onSelect: (generation: Generation) => void }) {
  const visibleGenerations = generations.slice(0, 2);
  return <section className="lf-history lf-panel"><header><span>▣</span><div><strong>Previous generated videos</strong><small>{generations.length} films in your recent gallery</small></div><b>Recent work</b></header>{visibleGenerations.length > 0 ? <div className="lf-history-grid">{visibleGenerations.map((generation) => <button key={generation.id} data-help="Select this previous generation to inspect and play it in the cinematic preview." onClick={() => onSelect(generation)}><GenerationThumbnail generation={generation}/><strong>{generation.prompt}</strong><small>{generation.status}</small></button>)}</div> : <div className="lf-history-empty" data-help="Completed and recent storyboard generations will be collected here for quick access."><span>▶</span><div><strong>Your storyboard films will collect here</strong><small>Generate the first cut to begin your history.</small></div></div>}<Link className="lf-history-more" to="/gallery" data-help="Open the complete gallery of generated videos.">More videos <span aria-hidden="true">→</span></Link></section>;
}

function GenerationThumbnail({ generation }: { generation: Generation }) {
  const storageKey = `vl_thumbnail_${generation.id}`;
  const [thumbnail, setThumbnail] = useState(() => localStorage.getItem(storageKey) ?? '');
  const video = useAuthenticatedVideo(thumbnail ? undefined : generation.output?.downloadUrl);

  useEffect(() => {
    if (thumbnail || !video.objectUrl) return;
    const source = document.createElement('video');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    let cancelled = false;
    let best: { score: number; image: string } | undefined;
    let sampleIndex = 0;
    const samplePositions = [.12, .28, .44, .6, .76, .9];
    canvas.width = 480;
    canvas.height = 360;
    source.src = video.objectUrl;
    source.muted = true;
    source.playsInline = true;
    source.preload = 'auto';

    const finish = () => {
      if (cancelled || !best) return;
      try { localStorage.setItem(storageKey, best.image); } catch { /* Storage can be unavailable or full. */ }
      setThumbnail(best.image);
    };
    const sample = () => {
      if (cancelled) return;
      const width = source.videoWidth;
      const height = source.videoHeight;
      if (!width || !height) return finish();
      const sourceRatio = width / height;
      const targetRatio = 4 / 3;
      let sx = 0; let sy = 0; let sw = width; let sh = height;
      if (sourceRatio > targetRatio) { sw = height * targetRatio; sx = (width - sw) / 2; }
      else { sh = width / targetRatio; sy = (height - sh) / 2; }
      context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let luminanceTotal = 0; let luminanceSquared = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        const luminance = pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722;
        luminanceTotal += luminance;
        luminanceSquared += luminance * luminance;
      }
      const count = pixels.length / 16;
      const mean = luminanceTotal / count;
      const variance = Math.max(0, luminanceSquared / count - mean * mean);
      if (mean > 18 && mean < 237) {
        const score = variance + Math.min(mean, 255 - mean) * 12;
        if (!best || score > best.score) best = { score, image: canvas.toDataURL('image/jpeg', .78) };
      }
      sampleIndex += 1;
      if (sampleIndex >= samplePositions.length) finish();
      else source.currentTime = Math.max(.01, source.duration * samplePositions[sampleIndex]);
    };
    source.addEventListener('loadedmetadata', () => {
      source.currentTime = Math.max(.01, source.duration * samplePositions[0]);
    }, { once: true });
    source.addEventListener('seeked', sample);
    source.addEventListener('error', finish, { once: true });
    return () => {
      cancelled = true;
      source.removeAttribute('src');
      source.load();
    };
  }, [generation.id, storageKey, thumbnail, video.objectUrl]);

  if (thumbnail) return <div className="lf-history-thumbnail"><img src={thumbnail} alt="Video thumbnail"/></div>;
  return <div className="lf-history-thumbnail placeholder"><span>{generation.status === 'completed' ? 'Preparing preview…' : generation.status}</span></div>;
}
