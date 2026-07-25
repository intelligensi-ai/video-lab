import type { CreditWallet, Generation, RuntimeStatus } from '@video-lab/contracts';
import { getStorage, ref, uploadBytes } from 'firebase/storage';
import { firebaseApp, getApiToken, getFirebaseUser, isProductionFirebase } from './auth.js';

const API = import.meta.env.VITE_API_BASE_URL ?? '/api';

export async function api<T>(path: string, init: RequestInit = {}) {
  const token = await getApiToken();
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail ?? body.title ?? r.statusText);
  }
  return r.json() as Promise<T>;
}

export async function fetchGenerationOutput(downloadUrl: string) {
  const token = await getApiToken();
  const path = downloadUrl.startsWith('/api/') ? downloadUrl.slice(4) : downloadUrl;
  const url = /^https?:\/\//i.test(path) ? path : `${API}${path}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail ?? body.title ?? response.statusText);
  }
  return response.blob();
}

export type ReferenceRole = 'startFrame' | 'endFrame' | 'referenceImage' | 'styleReference' | 'subjectReference';

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
  aspectRatio: '16:9' | '9:16' | '1:1';
  duration: 4 | 8 | 12;
  durationSeconds: 4 | 8 | 12;
  seed?: number;
  guidance: number;
  cfgGuidance: number;
  frameRate: number;
  motionStrength: number;
  cameraMotion: string;
  frameInfluence: number;
  promptMode: string;
  quality: 'draft' | 'standard' | 'high';
  outputFormat: string;
  references: SulphurReferenceInput[];
}

const strengthAliasByRole: Record<ReferenceRole, string> = {
  startFrame: 'startFrameStrength',
  endFrame: 'endFrameStrength',
  referenceImage: 'referenceImageStrength',
  styleReference: 'styleReferenceStrength',
  subjectReference: 'subjectReferenceStrength',
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

async function storeUserAsset(file: File | undefined, purpose: string) {
  if (!file || !isProductionFirebase || !firebaseApp) return;
  const user = await getFirebaseUser();
  const safeName = file.name.replace(/[^\w.-]/g, '_');
  const objectPath = `users/${user.uid}/uploads/${crypto.randomUUID()}-${safeName}`;
  await uploadBytes(ref(getStorage(firebaseApp), objectPath), file, {
    contentType: file.type,
    customMetadata: { purpose },
  });
}

export async function generateSulphurVideo(payload: SulphurGenerationPayload) {
  await Promise.all(payload.references.map((reference) =>
    storeUserAsset(reference.file, reference.role),
  ));
  const references = await Promise.all(
    payload.references.map(async (ref) => ({
      ...ref,
      dataUrl: await fileToDataUrl(ref.file),
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
  const generation = await api<Generation>('/v1/generations', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      prompt: payload.prompt,
      settings: {
        aspectRatio: payload.aspectRatio,
        durationSeconds: payload.durationSeconds,
        quality: payload.quality,
        seed: payload.seed,
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
      },
      inputAssets: [],
    }),
  });
  startRuntimeWorker();
  return generation;
}

export const getCredits = () => api<CreditWallet>('/v1/credits');
export const getRuntimeStatus = () => api<RuntimeStatus>('/v1/runtime/status');
export const getGeneration = (id: string) => api<Generation>(`/v1/generations/${id}`);
export const getGallery = () => api<{ items: Generation[] }>('/v1/gallery');
export const cancelGeneration = (id: string) => api<Generation>(`/v1/generations/${id}/cancel`, { method: 'POST' });
export const processOne = () => api('/v1/runtime/process-next', { method: 'POST' });

function startRuntimeWorker() {
  void processOne().catch((error) => {
    console.error('Generation worker request failed', error);
  });
}

export type StoryboardTransition = 'cut' | 'crossfade' | 'fade_black' | 'fade_white' | 'slide_left' | 'slide_right' | 'wipe_left' | 'wipe_right' | 'zoom_warp' | 'radial' | 'blur_dissolve';

export interface StoryboardScenePayload {
  id: string;
  title: string;
  prompt: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
  seed: number;
  transition: StoryboardTransition;
  transitionDuration: number;
  startFrame?: File;
  endFrame?: File;
  carryPreviousFrame: boolean;
}

export interface LongFormGenerationPayload {
  overallGoal: string;
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
  seedMode: string;
  baseSeed: number;
  globalVisualAnchorEnabled: boolean;
  globalVisualAnchor?: File;
  references: SulphurReferenceInput[];
  scenes: StoryboardScenePayload[];
}

export async function generateLongFormVideo(payload: LongFormGenerationPayload) {
  await Promise.all([
    storeUserAsset(payload.globalVisualAnchor, 'globalVisualAnchor'),
    ...payload.references.map((reference) => storeUserAsset(reference.file, reference.role)),
    ...payload.scenes.flatMap((scene) => [
      storeUserAsset(scene.startFrame, `${scene.id}:startFrame`),
      storeUserAsset(scene.endFrame, `${scene.id}:endFrame`),
    ]),
  ]);
  const globalVisualAnchorBase64 =
    payload.globalVisualAnchorEnabled
      ? await fileToDataUrl(payload.globalVisualAnchor)
      : undefined;
  const storyboard = await Promise.all(payload.scenes.map(async (scene) => {
    const startFrameBase64 = await fileToDataUrl(scene.startFrame);
    const endFrameBase64 = await fileToDataUrl(scene.endFrame);
    return {
      ...scene,
      startFrame: undefined,
      endFrame: undefined,
      startFrameBase64,
      endFrameBase64,
    };
  }));
  const durationSeconds = storyboard.reduce((total, scene) => total + Math.max(0.1, scene.trimEnd - scene.trimStart), 0);
  const generation = await api<Generation>('/v1/generations', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      prompt: payload.overallGoal,
      settings: {
        runtime: 'longform-ltx-storyboard-studio',
        aspectRatio: payload.resolution.startsWith('576x') || payload.resolution.startsWith('720x1280') ? '9:16' : payload.resolution.startsWith('1080x1080') ? '1:1' : '16:9',
        durationSeconds,
        quality: payload.postProcess === 'none' ? 'draft' : 'high',
        seed: payload.baseSeed,
        overallGoal: payload.overallGoal,
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
        seedMode: payload.seedMode,
        globalVisualAnchorEnabled: payload.globalVisualAnchorEnabled,
        globalVisualAnchorBase64,
        storyboard,
      },
      inputAssets: [],
    }),
  });
  startRuntimeWorker();
  return generation;
}
