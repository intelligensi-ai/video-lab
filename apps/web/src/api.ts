import type { CreditWallet, Generation, RuntimeStatus } from '@video-lab/contracts';

const API = import.meta.env.VITE_API_BASE_URL ?? '/api';
const token = () => localStorage.getItem('vl_token') || 'demo-user';

export async function api<T>(path: string, init: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, ...init.headers },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail ?? body.title ?? r.statusText);
  }
  return r.json() as Promise<T>;
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

interface UploadUrlResponse {
  assetId: string;
  uploadUrl: string;
  method: string;
  expiresAt: string;
  objectPath: string;
}

const assetAliasByRole: Record<ReferenceRole, string> = {
  startFrame: 'startFrameAssetId',
  endFrame: 'endFrameAssetId',
  referenceImage: 'referenceImageAssetId',
  styleReference: 'styleReferenceAssetId',
  subjectReference: 'subjectReferenceAssetId',
};

const strengthAliasByRole: Record<ReferenceRole, string> = {
  startFrame: 'startFrameStrength',
  endFrame: 'endFrameStrength',
  referenceImage: 'referenceImageStrength',
  styleReference: 'styleReferenceStrength',
  subjectReference: 'subjectReferenceStrength',
};

async function uploadReferenceAsset(ref: SulphurReferenceInput) {
  if (ref.assetId) return ref.assetId;
  if (!ref.file) return undefined;
  const upload = await api<UploadUrlResponse>('/v1/assets/upload-url', {
    method: 'POST',
    body: JSON.stringify({ fileName: ref.file.name, contentType: ref.file.type, sizeBytes: ref.file.size, purpose: ref.role }),
  });
  const put = await fetch(upload.uploadUrl, { method: upload.method || 'PUT', headers: { 'content-type': ref.file.type }, body: ref.file });
  if (!put.ok) throw new Error(`Upload failed for ${ref.file.name}: ${put.statusText}`);
  return upload.assetId;
}

export async function generateSulphurVideo(payload: SulphurGenerationPayload) {
  const uploaded = await Promise.all(payload.references.map(async (ref) => ({ ...ref, assetId: await uploadReferenceAsset(ref) })));
  const aliases = uploaded.reduce<Record<string, string | number>>((acc, ref) => {
    if (ref.assetId) acc[assetAliasByRole[ref.role]] = ref.assetId;
    acc[strengthAliasByRole[ref.role]] = ref.strength;
    return acc;
  }, {});
  const inputAssets = uploaded.filter((ref) => ref.assetId).map((ref) => ({ assetId: ref.assetId, role: ref.role, strength: ref.strength }));
  return api<Generation>('/v1/generations', {
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
        ...aliases,
      },
      inputAssets,
    }),
  });
}

export const getCredits = () => api<CreditWallet>('/v1/credits');
export const getRuntimeStatus = () => api<RuntimeStatus>('/v1/runtime/status');
export const getGeneration = (id: string) => api<Generation>(`/v1/generations/${id}`);
export const getGallery = () => api<{ items: Generation[] }>('/v1/gallery');
export const cancelGeneration = (id: string) => api<Generation>(`/v1/generations/${id}/cancel`, { method: 'POST' });
export const processOne = () => api('/v1/dev/process-one', { method: 'POST' });
