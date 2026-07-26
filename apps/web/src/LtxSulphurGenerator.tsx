import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Generation } from '@video-lab/contracts';
import { generateSulphurVideo, getCredits, getGeneration, getRuntimeStatus, type ReferenceRole, type SulphurGenerationPayload } from './api.js';
import { useAuthenticatedVideo } from './AuthenticatedVideo.js';
import { PromptSuggestion } from './PromptSuggestion.js';

const promptModes = ['Cinematic', 'Storyboard', 'Product', 'Character'] as const;
const qualityPresets = ['draft', 'standard', 'high'] as const;
const sulphurQualityDefaults = { draft: { guidance: 3, cfgGuidance: 3, frameRate: 24 }, standard: { guidance: 5, cfgGuidance: 5, frameRate: 24 }, high: { guidance: 7, cfgGuidance: 7, frameRate: 30 } };
const previewCropAspectRatio = '16:9';
const previewCropAspectLabel = '16:9 landscape crop target';

type RefState = { label: string; role: ReferenceRole; file?: File; preview?: string; strength: number };
type FormState = {
  prompt: string; rewrittenPrompt: string; negativePrompt: string; promptMode: (typeof promptModes)[number]; quality: (typeof qualityPresets)[number]; duration: 4 | 8 | 12;
  resolution: string; aspectRatio: '16:9' | '9:16' | '1:1'; frameRate: number; seed: string; guidance: number; cfgGuidance: number; motionStrength: number; cameraMotion: string; frameInfluence: number; enhancePrompt: boolean; outputFormat: string; references: RefState[];
};

const initialReferences: RefState[] = [
  { label: 'Start Frame', role: 'startFrame', strength: 0.75 }, { label: 'End Frame', role: 'endFrame', strength: 0.75 }, { label: 'Reference Image', role: 'referenceImage', strength: 0.6 }, { label: 'Style Reference', role: 'styleReference', strength: 0.5 }, { label: 'Subject Reference', role: 'subjectReference', strength: 0.65 },
];

function initialForm(): FormState { return { prompt: '', rewrittenPrompt: '', negativePrompt: '', promptMode: 'Cinematic', quality: 'standard', duration: 4, resolution: '1280x720', aspectRatio: '16:9', frameRate: 24, seed: '', guidance: 5, cfgGuidance: 5, motionStrength: 0.55, cameraMotion: 'Slow dolly in', frameInfluence: 0.65, enhancePrompt: true, outputFormat: 'mp4', references: initialReferences }; }

export function hasSulphurGenerationInput(form: FormState) { return form.prompt.trim().length > 0 || form.references.some((ref) => ref.file); }
export function previewFileAssetId(ref: RefState) { return ref.file ? `${ref.role}:${ref.file.name}` : undefined; }
export function expandSulphurPreviewInput(form: FormState) { return { ...form, cropAspectRatio: previewCropAspectRatio, cropAspectLabel: previewCropAspectLabel }; }
export function buildSulphurPayload(form: FormState): SulphurGenerationPayload { return { prompt: (form.rewrittenPrompt || form.prompt).trim(), negativePrompt: form.negativePrompt.trim() || undefined, enhancePrompt: form.enhancePrompt, resolution: form.resolution, aspectRatio: form.aspectRatio, duration: form.duration, durationSeconds: form.duration, seed: form.seed === '' ? undefined : Number(form.seed), guidance: form.guidance, cfgGuidance: form.cfgGuidance, frameRate: form.frameRate, motionStrength: form.motionStrength, cameraMotion: form.cameraMotion, frameInfluence: form.frameInfluence, promptMode: form.promptMode, quality: form.quality, outputFormat: form.outputFormat, references: form.references.filter((ref) => ref.file).map((ref) => ({ role: ref.role, file: ref.file, strength: ref.strength })) }; }

function validate(form: FormState) { const errors: string[] = []; if (!hasSulphurGenerationInput(form)) errors.push('Add a prompt or at least one visual reference.'); const prompt = (form.rewrittenPrompt || form.prompt).trim(); if (prompt && (prompt.length < 8 || prompt.length > 1200)) errors.push('Prompt must be 8-1200 characters.'); if (![4, 8, 12].includes(form.duration)) errors.push('Duration must be 4, 8, or 12 seconds.'); if (form.seed !== '' && (!Number.isInteger(Number(form.seed)) || Number(form.seed) < 0)) errors.push('Randomiser must be a positive whole number.'); if (form.guidance < 0 || form.guidance > 20 || form.cfgGuidance < 0 || form.cfgGuidance > 20) errors.push('Guidance values must be between 0 and 20.'); if (!/^\d+x\d+$/.test(form.resolution)) errors.push('Resolution must look like 1280x720.'); return errors; }

export default function SulphurGeneratorPage() {
  const [form, setForm] = useState(initialForm);
  const [history, setHistory] = useState<Generation[]>([]);
  const [selected, setSelected] = useState<Generation | undefined>();
  const validation = useMemo(() => validate(form), [form]);
  const credits = useQuery({ queryKey: ['credits'], queryFn: getCredits });
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: getRuntimeStatus });
  const mutation = useMutation({
    mutationFn: () => generateSulphurVideo(buildSulphurPayload(form)),
    onSuccess: (generation) => {
      setSelected(generation);
      setHistory((items) => [generation, ...items].slice(0, 8));
    },
  });
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
  const isRendering = mutation.isPending || Boolean(
    currentGeneration && !['completed', 'failed', 'cancelled'].includes(currentGeneration.status),
  );

  return <main className="generator-page">
    <header className="studio-topbar">
      <div>
        <span>Video Lab Studio</span>
        <h1 className="editorial-page-title">Video Studio<span className="editorial-title-stop">.</span></h1>
      </div>
      <div className="studio-health" aria-label="Studio status">
        <span><i/>{runtime.data?.status ?? 'Checking'}</span>
        <span><b>{credits.data?.available ?? '…'}</b> credits</span>
        <Link to="/gallery">Open gallery ↗</Link>
      </div>
    </header>

    <div className="studio-workbench">
      <section className="studio-compose">
        <PromptComposer form={form} setForm={setForm}/>
        {validation.length > 0 && form.prompt.length > 0 && <div className="error-panel studio-errors">
          {validation.map((error) => <p key={error}>{error}</p>)}
        </div>}
        <button
          className="studio-generate"
          disabled={isRendering || validation.length > 0}
          onClick={() => mutation.mutate()}
        >
          <span>{isRendering ? 'Creating your video…' : 'Generate video'}</span>
          <b>{isRendering ? '●' : '→'}</b>
        </button>
        <VisualReferencePanel form={form} setForm={setForm}/>
        <GenerationControls form={form} setForm={setForm}/>
        <details className="panel studio-disclosure developer-mode">
          <summary><span>Developer mode</span><small>Request payload and crop metadata</small></summary>
          <pre className="preview-json">{JSON.stringify(expandSulphurPreviewInput(form), null, 2)}</pre>
        </details>
      </section>

      <aside className="studio-preview-column">
        <GenerationPreview
          generation={currentGeneration}
          isLoading={isRendering}
          error={mutation.error}
          onRegenerate={() => mutation.mutate()}
        />
      </aside>
    </div>

    <GenerationHistory
      items={history}
      onOpen={setSelected}
      onReuse={(item) => {
        setForm((current) => ({
          ...current,
          prompt: item.prompt,
          duration: ([4, 8, 12].includes(item.settings.durationSeconds)
            ? item.settings.durationSeconds
            : current.duration) as 4 | 8 | 12,
          quality: item.settings.quality,
          seed: item.settings.seed === undefined ? '' : String(item.settings.seed),
        }));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
      onRemove={(id) => setHistory((items) => items.filter((item) => item.id !== id))}
    />
  </main>;
}

function PromptComposer({
  form,
  setForm,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
  const modeIcons: Record<FormState['promptMode'], string> = {
    Cinematic: '🎬',
    Storyboard: '▦',
    Product: '◆',
    Character: '●',
  };

  return <section className="panel studio-prompt-card">
    <header>
      <div>
        <span className="studio-eyebrow">Start with an idea</span>
        <h2>Describe your cinematic scene</h2>
      </div>
      <div className="prompt-heading-actions">
        <PromptSuggestion
          value={form.prompt}
          suggestion="A cinematic reveal of an intelligent glass monolith floating over an ocean at sunrise, with a slow dolly-in and warm reflections across the water."
          expansion="Develop the idea with a clear subject action, purposeful camera movement, lens and composition, lighting direction, material detail, atmosphere and a strong final frame."
          kind="video-scene"
          onUse={(suggestion) => setForm((current) => ({ ...current, prompt: suggestion }))}
        />
        <span className={form.prompt.length > 1000 ? 'character-count warning' : 'character-count'}>
          {form.prompt.length} characters
        </span>
      </div>
    </header>
    <textarea
      className="studio-prompt-input"
      value={form.prompt}
      maxLength={1200}
      rows={7}
      placeholder="Describe your cinematic scene…"
      onInput={(event) => {
        const target = event.currentTarget;
        target.style.height = 'auto';
        target.style.height = `${Math.min(target.scrollHeight, 360)}px`;
      }}
      onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
    />
    <div className="studio-preset-group">
      <span className="studio-field-label">Creative preset</span>
      <div className="studio-presets">
        {promptModes.map((mode) => <button
          key={mode}
          className={mode === form.promptMode ? 'selected' : ''}
          onClick={() => setForm((current) => ({ ...current, promptMode: mode }))}
        >
          <i>{modeIcons[mode]}</i><span>{mode}</span>
        </button>)}
      </div>
    </div>
    <div className="studio-basics">
      <label>Duration<select value={form.duration} onChange={(event) => setForm((current) => ({ ...current, duration: Number(event.target.value) as 4 | 8 | 12 }))}><option value={4}>4 seconds</option><option value={8}>8 seconds</option><option value={12}>12 seconds</option></select></label>
      <label>Quality<select value={form.quality} onChange={(event) => { const quality = event.target.value as FormState['quality']; setForm((current) => ({ ...current, quality, ...sulphurQualityDefaults[quality] })); }}><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></label>
    </div>
    <details className="advanced-prompt">
      <summary>Advanced prompt controls</summary>
      <div className="prompt-field">
        <div className="prompt-field-heading"><span>Negative prompt</span><PromptSuggestion value={form.negativePrompt} suggestion="Avoid flicker, warped anatomy, duplicate subjects, unreadable text, watermarks and abrupt camera movement." expansion="Also exclude visual artefacts, identity drift, inconsistent lighting, unwanted text, unstable motion and anything that conflicts with the intended cinematic style." kind="negative" onUse={(suggestion) => setForm((current) => ({ ...current, negativePrompt: suggestion }))}/></div>
        <textarea className="small-textarea" aria-label="Negative prompt" value={form.negativePrompt} placeholder="Describe anything the model should avoid…" onChange={(event) => setForm((current) => ({ ...current, negativePrompt: event.target.value }))}/>
      </div>
      <label className="studio-check"><input type="checkbox" checked={form.enhancePrompt} onChange={(event) => setForm((current) => ({ ...current, enhancePrompt: event.target.checked }))}/><span>Enhance my prompt automatically</span></label>
    </details>
  </section>;
}

function VisualReferencePanel({
  form,
  setForm,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
  const uploadedCount = form.references.filter((reference) => reference.file).length;
  return <details className="panel studio-disclosure">
    <summary><span>Frames &amp; identity</span><small>{uploadedCount ? `${uploadedCount} reference${uploadedCount === 1 ? '' : 's'} added` : 'Optional start, end and style references'}</small></summary>
    <div className="reference-grid">
      {form.references.map((reference, index) => <ReferenceUploadCard
        key={reference.role}
        refState={reference}
        onChange={(next) => setForm((current) => ({
          ...current,
          references: current.references.map((item, itemIndex) => itemIndex === index ? next : item),
        }))}
      />)}
    </div>
  </details>;
}

function ReferenceUploadCard({ refState, onChange }: { refState: RefState; onChange: (reference: RefState) => void }) {
  return <article className="reference-card">
    <strong>{refState.label}</strong>
    <label className="upload-preview">
      {refState.preview ? <img src={refState.preview} alt=""/> : <><span>＋</span><small>Add image</small></>}
      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onChange({ ...refState, file, preview: URL.createObjectURL(file) });
      }}/>
    </label>
    <label>Influence <b>{refState.strength.toFixed(2)}</b><input type="range" min={0} max={1} step={0.05} value={refState.strength} onChange={(event) => onChange({ ...refState, strength: Number(event.target.value) })}/></label>
    <small>{previewFileAssetId(refState) ?? 'No image selected'}</small>
  </article>;
}

function GenerationControls({
  form,
  setForm,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
  return <details className="panel studio-disclosure advanced-generation">
    <summary><span>Advanced settings</span><small>Output, motion, AI guidance and seed</small></summary>
    <div className="advanced-groups">
      <fieldset><legend>Output</legend><div className="control-grid">
        <label>Resolution<input value={form.resolution} onChange={(event) => setForm((current) => ({ ...current, resolution: event.target.value }))}/></label>
        <label>Aspect ratio<select value={form.aspectRatio} onChange={(event) => setForm((current) => ({ ...current, aspectRatio: event.target.value as FormState['aspectRatio'] }))}><option>16:9</option><option>9:16</option><option>1:1</option></select></label>
        <label>Frame rate<input type="number" value={form.frameRate} onChange={(event) => setForm((current) => ({ ...current, frameRate: Number(event.target.value) }))}/></label>
        <label>Format<select value={form.outputFormat} onChange={(event) => setForm((current) => ({ ...current, outputFormat: event.target.value }))}><option>mp4</option><option>webm</option></select></label>
      </div></fieldset>
      <fieldset><legend>Motion</legend><div className="control-grid">
        <label>Motion strength<input type="range" min={0} max={1} step={0.05} value={form.motionStrength} onChange={(event) => setForm((current) => ({ ...current, motionStrength: Number(event.target.value) }))}/></label>
        <label>Camera motion<input value={form.cameraMotion} onChange={(event) => setForm((current) => ({ ...current, cameraMotion: event.target.value }))}/></label>
        <label>Frame influence<input type="range" min={0} max={1} step={0.05} value={form.frameInfluence} onChange={(event) => setForm((current) => ({ ...current, frameInfluence: Number(event.target.value) }))}/></label>
      </div></fieldset>
      <fieldset><legend>AI guidance</legend><div className="control-grid">
        <label>CFG guidance<input type="number" step="0.5" value={form.cfgGuidance} onChange={(event) => setForm((current) => ({ ...current, cfgGuidance: Number(event.target.value) }))}/></label>
        <label>Guidance<input type="number" step="0.5" value={form.guidance} onChange={(event) => setForm((current) => ({ ...current, guidance: Number(event.target.value) }))}/></label>
        <label>Seed<input value={form.seed} placeholder="Random" onChange={(event) => setForm((current) => ({ ...current, seed: event.target.value }))}/><button onClick={() => setForm((current) => ({ ...current, seed: String(Math.floor(Math.random() * 2147483647)) }))}>Randomise</button></label>
      </div></fieldset>
    </div>
  </details>;
}

function GenerationPreview({
  generation,
  isLoading,
  error,
  onRegenerate,
}: {
  generation?: Generation;
  isLoading: boolean;
  error: Error | null;
  onRegenerate: () => void;
}) {
  const video = useAuthenticatedVideo(generation?.output?.downloadUrl);
  return <section className="panel studio-preview">
    <header><div><span className="studio-eyebrow">Preview</span><h2>Your film</h2></div>{generation && <span className={`preview-status ${generation.status}`}>{generation.status}</span>}</header>
    <div className={`studio-screen ${isLoading ? 'rendering' : ''}`}>
      {video.objectUrl ? <video src={video.objectUrl} controls playsInline/> : isLoading ? <div className="render-state">
        <img src="/images/longform-ltx-storyboard-studio-film-roll.webp" alt=""/>
        <div><span className="render-icon">✦</span><strong>Creating your video</strong><p>Building frames, motion and detail…</p><i><b/></i></div>
      </div> : generation?.output?.downloadUrl ? <div className="preview-empty film-preview"><img src="/images/longform-ltx-storyboard-studio-film-roll.webp" alt=""/><div><span>↻</span><strong>Preparing your video</strong><p>Your finished film is being retrieved.</p></div></div> : <div className="preview-empty film-preview">
        <img src="/images/longform-ltx-storyboard-studio-film-roll.webp" alt="A film roll showing connected cinematic frames"/>
        <div><span>▶</span><strong>Your generated video will appear here</strong><p>Generation usually takes 20–40 seconds.</p></div>
      </div>}
    </div>
    {generation && <div className="preview-meta"><span><b>{generation.settings.durationSeconds}s</b> duration</span><span><b>{generation.creditCost}</b> credits</span><span><b>{generation.settings.seed ?? 'Auto'}</b> seed</span></div>}
    {video.error && <div className="error-panel"><p>Video retrieval failed: {video.error}</p></div>}
    {error && <div className="error-panel"><strong>Generation failed</strong><p>{error.message}</p></div>}
    <div className="preview-actions">
      {video.objectUrl && <a className="button" href={video.objectUrl} download={`${generation?.id ?? 'video'}.mp4`}>Download</a>}
      <Link className="button secondary" to="/gallery">Open in gallery</Link>
      {generation && <button onClick={onRegenerate}>Regenerate</button>}
    </div>
  </section>;
}

function GenerationHistory({
  items,
  onOpen,
  onReuse,
  onRemove,
}: {
  items: Generation[];
  onOpen: (generation: Generation) => void;
  onReuse: (generation: Generation) => void;
  onRemove: (id: string) => void;
}) {
  return <section className="studio-history">
    <header><div><span className="studio-eyebrow">Recent work</span><h2>Session history</h2></div><Link to="/gallery">View full gallery →</Link></header>
    {items.length ? <div className="studio-history-grid">{items.map((item) => <HistoryCard key={item.id} item={item} onOpen={onOpen} onReuse={onReuse} onRemove={onRemove}/>)}</div> : <div className="history-empty"><span>▦</span><div><strong>Your recent videos will collect here</strong><p>Generate your first film to begin a session.</p></div></div>}
  </section>;
}

function HistoryCard({
  item,
  onOpen,
  onReuse,
  onRemove,
}: {
  item: Generation;
  onOpen: (generation: Generation) => void;
  onReuse: (generation: Generation) => void;
  onRemove: (id: string) => void;
}) {
  const video = useAuthenticatedVideo(item.output?.downloadUrl);
  return <article className="history-card">
    <button className="history-media" onClick={() => onOpen(item)} aria-label={`Open ${item.prompt}`}>
      {video.objectUrl ? <video src={video.objectUrl} muted preload="metadata"/> : <img src="/images/longform-ltx-storyboard-studio-film-roll.webp" alt=""/>}
      <span>{item.status}</span><i>▶</i>
    </button>
    <div className="history-copy"><strong>{item.prompt}</strong><p>{item.settings.durationSeconds}s · Seed {item.settings.seed ?? 'Auto'} · {item.settings.quality}</p></div>
    <footer>
      <button onClick={() => onReuse(item)}>Reuse</button>
      {video.objectUrl && <a href={video.objectUrl} download={`${item.id}.mp4`}>Download</a>}
      <button className="remove" onClick={() => onRemove(item.id)}>Remove</button>
    </footer>
  </article>;
}
