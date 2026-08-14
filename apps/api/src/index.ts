import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import YAML from "yaml";
import { nanoid } from "nanoid";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { longFormVideoModels, MAX_STORYBOARD_SCENES } from "@video-lab/contracts";
import type {
  CreditWallet,
  DirectorProposal,
  DirectorProposalDiff,
  DirectorProposalResult,
  Generation,
  Me,
  RuntimeStatus,
  StoryboardProject,
  StoryboardProjectSummary,
  StoryboardAudioPolicy,
  StoryboardContinuityBible,
  StoryboardEnhancementRequest,
  StoryboardEnhancementResponse,
  StoryboardEnhancementRuntimeContext,
  StoryboardReferenceSummary,
  StoryboardReferenceType,
  StoryboardVisualReferenceEnvelope,
} from "@video-lab/contracts";
import {
  chargeCredits,
  claimNext,
  createWallet,
  releaseCredits,
  type QueueItem,
} from "@video-lab/domain";
import {
  createRuntimeFromEnv,
  DeployStudioStoryboardEnhancerClient,
  mockStoryboardEnhancement,
  SulphurLtxRuntimeAdapter,
  RuntimeCapacityPendingError,
  RuntimeLeaseUnavailableError,
  boundedInteger,
  type RuntimeGenerationInput,
  type RuntimeVideoSettings,
} from "@video-lab/runtime-adapter";
import { log, nowIso, problem } from "@video-lab/shared";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import {
  corsOptions,
  normalizeRuntimeOrigin,
  rateLimit,
  runtimeOriginAllowed,
  securityHeaders,
} from "./security.js";
import {
  applyDirectorProposal,
  buildDirectorEnhancementRequest,
  classifyDirectorMessage,
  proposalCopy,
} from "./director.js";
import {
  MAX_DIRECTOR_VISUAL_BYTES,
  MAX_DIRECTOR_VISUAL_REFERENCES,
  normalizeVisualReference,
  sha256,
  type SupportedReferenceContentType,
} from "./visualReferences.js";
type Principal = { uid: string; email: string; admin: boolean };
let runtime = createRuntimeFromEnv();
type StoredGeneration = Generation & {
  uid: string;
  runtimeJobId?: string;
  assemblyRuntimeAttempt?: number;
  referenceSnapshot?: StoredGenerationReferenceSnapshot[];
  outputBytes?: Uint8Array;
  outputContentType?: string;
  outputObjectPath?: string;
  outputSha256?: string;
};
type StoredGenerationEdit = {
  id: string;
  uid: string;
  generationId: string;
  startSeconds: number;
  endSeconds: number;
  status: "processing" | "completed" | "failed";
  output?: {
    downloadUrl: string;
    durationSeconds: number;
    contentType: "video/mp4";
    kind: "video";
  };
  outputBytes?: Uint8Array;
  outputObjectPath?: string;
  outputSha256?: string;
  safeErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
};
type StoredAsset = {
  id: string;
  uid: string;
  purpose: string;
  objectPath: string;
  contentType: string;
  expectedSize: number;
  createdAt: string;
  uploadExpiresAt?: string;
  /** @deprecated Legacy upload-session expiry. It is not asset retention. */
  expiresAt?: string;
  uploadedAt?: string;
  sourceSha256?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  sourcePixelCount?: number;
  bytes?: Uint8Array;
};
type StoredGenerationReferenceSnapshot = {
  id: string;
  type: "character" | "location" | "product" | "style";
  version: number;
  assetId: string;
  normalizedSha256: string;
  normalizedByteLength: number;
  sceneIds: string[];
};
type StoredStoryboardProject = {
  id: string;
  uid: string;
  title: string;
  form: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
type StoredDirectorProposal = DirectorProposal & { uid: string };
const users = new Map<string, Me>();
const wallets = new Map<string, CreditWallet>();
const gens = new Map<string, StoredGeneration>();
const queue: QueueItem[] = [];
const idempotency = new Map<string, string>();
const generationQueueCollection = "generationQueue";
const generationIdempotencyCollection = "generationIdempotency";
const generationActiveCollection = "generationActive";
const queueMetricsDocument = "queueMetrics";
const storyboardDrafts = new Map<
  string,
  { form: Record<string, unknown>; updatedAt: string }
>();
const storyboardProjects = new Map<string, StoredStoryboardProject>();
const directorProposals = new Map<string, StoredDirectorProposal>();
const assets = new Map<string, StoredAsset>();
const generationEdits = new Map<string, StoredGenerationEdit>();
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const packagedFfmpeg = require("@ffmpeg-installer/ffmpeg") as { path?: string };
let runtimeState: RuntimeStatus = {
  provider: process.env.VIDEO_RUNTIME_PROVIDER ?? "mock",
  status: "healthy",
  acceptingSubmissions: true,
  killSwitch: false,
  queueDepth: 0,
  updatedAt: nowIso(),
  lastHeartbeatAt: nowIso(),
};
let runtimeControlCheckedAt = 0;
function operationalErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (/^runtime_[a-z0-9_]+$/.test(code)) return code;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout")) return "runtime_timeout";
  if (/unauthori[sz]ed|forbidden|\b401\b|\b403\b/.test(message))
    return "runtime_authentication";
  if (/network|fetch|econn|socket|dns/.test(message)) return "runtime_network";
  if (/invalid|schema|json|unexpected/.test(message))
    return "runtime_invalid_response";
  return "runtime_failure";
}
const base64FieldByObjectPathField: Record<string, string> = {
  globalVisualAnchorObjectPath: "globalVisualAnchorBase64",
  seedFrameObjectPath: "seedFrameBase64",
  startFrameObjectPath: "startFrameBase64",
  endFrameObjectPath: "endFrameBase64",
  referenceImageObjectPath: "referenceImageBase64",
  styleReferenceObjectPath: "styleReferenceBase64",
  subjectReferenceObjectPath: "subjectReferenceBase64",
  temporalKeyframeObjectPath: "temporalKeyframeBase64",
};
const assetIdFieldByObjectPathField: Record<string, string> =
  Object.fromEntries(
    Object.keys(base64FieldByObjectPathField).map((objectPathField) => [
      objectPathField,
      objectPathField.replace(/ObjectPath$/, "AssetId"),
    ]),
  );
export function stripEmbeddedMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEmbeddedMedia);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.endsWith("Base64") && !key.endsWith("ObjectPath"))
      .map(([key, nested]) => [key, stripEmbeddedMedia(nested)]),
  );
}
function publicGeneration(g: StoredGeneration): Generation {
  const {
    uid: _uid,
    runtimeJobId: _runtimeJobId,
    assemblyRuntimeAttempt: _assemblyRuntimeAttempt,
    referenceSnapshot: _referenceSnapshot,
    outputBytes: _outputBytes,
    outputContentType: _outputContentType,
    outputObjectPath: _outputObjectPath,
    outputSha256: _outputSha256,
    ...generation
  } = g;
  if (["completed", "failed", "cancelled"].includes(generation.status)) {
    delete generation.runtimeMessage;
    delete generation.runtimeProgress;
    generation.queuePosition = 0;
  }
  return {
    ...generation,
    settings: stripEmbeddedMedia(generation.settings) as Generation["settings"],
  };
}
function storedGenerationRecord(g: StoredGeneration) {
  const { outputBytes: _outputBytes, ...stored } = g;
  return JSON.parse(JSON.stringify(stored));
}
function isOwnedUploadPath(value: string, uid: string) {
  return (
    value.startsWith(`users/${uid}/uploads/`) &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}
function validateAssetReferences(value: unknown, uid: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => validateAssetReferences(item, uid));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (key in base64FieldByObjectPathField) {
      if (typeof nested !== "string" || !isOwnedUploadPath(nested, uid))
        throw problem(403, "asset_forbidden", "Asset is not owned by caller");
    } else validateAssetReferences(nested, uid);
  }
}
async function persistAsset(asset: StoredAsset) {
  assets.set(asset.id, asset);
  if (localAuth) return;
  adminApp();
  const { bytes: _bytes, ...stored } = asset;
  await getFirestore().collection("assets").doc(asset.id).set(stored);
}

function validateRuntimeTemporalKeyframes(
  value: unknown,
  duration: number,
  sceneNumber: number,
  uid: string,
) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_INTERMEDIATE_KEYFRAMES) {
    throw problem(
      400,
      "invalid_temporal_keyframes",
      `Scene ${sceneNumber} supports up to ${MAX_INTERMEDIATE_KEYFRAMES} intermediate frame anchors`,
    );
  }
  if (value.length > 0 && runtimeState.capabilities?.intermediateKeyframes !== true) {
    throw problem(
      409,
      "capability_unavailable",
      "The connected runtime has not verified intermediate frame anchors",
    );
  }
  let previousTime = 0;
  const identifiers = new Set<string>();
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw problem(400, "invalid_temporal_keyframes", `Scene ${sceneNumber} intermediate frame ${index + 1} is invalid`);
    }
    const source = entry as Record<string, unknown>;
    if (Object.keys(source).some((key) => !["id", "timeSeconds", "strength", "temporalKeyframeObjectPath"].includes(key))) {
      throw problem(400, "invalid_temporal_keyframes", `Scene ${sceneNumber} intermediate frame ${index + 1} contains unsupported fields`);
    }
    const id = String(source.id ?? "");
    const timeSeconds = Number(source.timeSeconds);
    const strength = Number(source.strength);
    const objectPath = String(source.temporalKeyframeObjectPath ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || identifiers.has(id)) {
      throw problem(400, "invalid_temporal_keyframes", "Intermediate frame identifiers must be unique and valid");
    }
    if (!Number.isFinite(duration) || !Number.isFinite(timeSeconds) || timeSeconds <= previousTime || timeSeconds >= duration) {
      throw problem(400, "invalid_temporal_keyframes", "Intermediate frame times must be ordered inside the scene duration");
    }
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw problem(400, "invalid_temporal_keyframes", "Intermediate frame strength must be between 0 and 1");
    }
    if (!objectPath || !isOwnedUploadPath(objectPath, uid)) {
      throw problem(403, "asset_forbidden", "An intermediate-frame asset is not owned by the caller");
    }
    identifiers.add(id);
    previousTime = timeSeconds;
  });
}
async function findAsset(id: string): Promise<StoredAsset | undefined> {
  const memory = assets.get(id);
  if (memory || localAuth) return memory;
  adminApp();
  const snapshot = await getFirestore().collection("assets").doc(id).get();
  if (!snapshot.exists) return undefined;
  const asset = snapshot.data() as StoredAsset;
  assets.set(id, asset);
  return asset;
}
async function resolveAssetIds(value: unknown, uid: string): Promise<unknown> {
  if (Array.isArray(value))
    return Promise.all(value.map((item) => resolveAssetIds(item, uid)));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => key.endsWith("ObjectPath")))
    throw problem(
      400,
      "invalid_asset_reference",
      "Private asset paths cannot be supplied by clients",
    );
  const resolved = Object.fromEntries(
    await Promise.all(
      Object.entries(source).map(async ([key, nested]) => [
        key,
        await resolveAssetIds(nested, uid),
      ]),
    ),
  );
  for (const [objectPathField, assetIdField] of Object.entries(
    assetIdFieldByObjectPathField,
  )) {
    const assetId = resolved[assetIdField];
    if (assetId === undefined) continue;
    if (typeof assetId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(assetId))
      throw problem(400, "invalid_asset", "Asset identifier is invalid");
    const asset = await findAsset(assetId);
    if (!asset || asset.uid !== uid || !asset.uploadedAt)
      throw problem(403, "asset_forbidden", "Asset is not owned by caller");
    resolved[objectPathField] = asset.objectPath;
    delete resolved[assetIdField];
  }
  return resolved;
}
function imageSignatureMatches(bytes: Buffer, contentType: string) {
  if (contentType === "image/png")
    return (
      bytes.length >= 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  if (contentType === "image/jpeg")
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
  if (contentType === "image/webp")
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  return false;
}

function assetUploadExpiresAt(asset: StoredAsset) {
  return asset.uploadExpiresAt ?? asset.expiresAt ?? asset.createdAt;
}

async function readStoredAssetBytes(asset: StoredAsset) {
  let bytes: Buffer;
  if (localAuth) {
    if (!asset.bytes) throw problem(404, "asset_not_found", "Private reference was not found");
    bytes = Buffer.from(asset.bytes);
  } else {
    adminApp();
    [bytes] = await getStorage().bucket().file(asset.objectPath).download();
  }
  if (
    bytes.byteLength !== asset.expectedSize ||
    !imageSignatureMatches(bytes, asset.contentType) ||
    (asset.sourceSha256 && sha256(bytes) !== asset.sourceSha256)
  ) {
    throw problem(500, "asset_corrupt", "Private reference could not be read safely");
  }
  return bytes;
}

async function ensureNormalizedReference(asset: StoredAsset) {
  const source = await readStoredAssetBytes(asset);
  let normalized: Awaited<ReturnType<typeof normalizeVisualReference>>;
  try {
    normalized = await normalizeVisualReference(
      source,
      asset.contentType as SupportedReferenceContentType,
    );
  } catch {
    throw problem(400, "reference_image_invalid", "The project reference is not a supported still image");
  }
  asset.sourceSha256 = normalized.sourceSha256;
  asset.sourceWidth = normalized.sourceWidth;
  asset.sourceHeight = normalized.sourceHeight;
  asset.sourcePixelCount = normalized.sourcePixelCount;
  await persistAsset(asset);
  return {
    bytes: normalized.bytes,
    contentType: normalized.contentType,
    byteLength: normalized.byteLength,
    sha256: normalized.sha256,
    width: normalized.width,
    height: normalized.height,
    pixelCount: normalized.pixelCount,
  } as const;
}

async function captureGenerationReferenceSnapshot(
  settings: Generation["settings"],
  project: StoredStoryboardProject | undefined,
  uid: string,
): Promise<StoredGenerationReferenceSnapshot[]> {
  if (Object.prototype.hasOwnProperty.call(settings, "referenceConditioning")) {
    throw problem(
      400,
      "invalid_reference_conditioning",
      "Private generation references are resolved by Video Lab",
    );
  }
  const storyboard = Array.isArray(settings.storyboard)
    ? (settings.storyboard as Array<Record<string, unknown>>)
    : [];
  const operationScope = String(settings.operationScope ?? "project");
  if (!["project", "scene"].includes(operationScope)) {
    storyboard.forEach((scene) => {
      scene.referenceIds = [];
    });
    return [];
  }
  if (!project) {
    if (
      storyboard.some(
        (scene) => Array.isArray(scene.referenceIds) && scene.referenceIds.length > 0,
      )
    ) {
      throw problem(
        400,
        "project_required",
        "Reference-conditioned generation requires a saved project",
      );
    }
    storyboard.forEach((scene) => {
      scene.referenceIds = [];
    });
    return [];
  }

  const projectScenes = Array.isArray(project.form.scenes)
    ? (project.form.scenes as Array<Record<string, unknown>>)
    : [];
  const projectSceneById = new Map(
    projectScenes.map((scene) => [String(scene.id ?? ""), scene]),
  );
  const rawReferences = Array.isArray(project.form.projectReferences)
    ? (project.form.projectReferences as Array<Record<string, unknown>>)
    : [];
  if (rawReferences.length > 0 && runtimeState.provider !== "mock") {
    await refreshRuntimeHealth();
  }
  const supportedReferences = new Map<string, Record<string, unknown>>();
  for (const reference of rawReferences) {
    const id = String(reference.id ?? "");
    const type = String(reference.type ?? "");
    const assetId = String(reference.assetId ?? "");
    if (
      /^[A-Za-z0-9_-]{8,64}$/.test(id) &&
      ["character", "location", "product", "style"].includes(type) &&
      /^[A-Za-z0-9_-]{8,64}$/.test(assetId)
    ) {
      supportedReferences.set(id, reference);
    }
  }

  const selectedSceneIdsByReference = new Map<string, Set<string>>();
  const targetedSceneId = operationScope === "scene"
    ? String(settings.operationSceneId ?? "")
    : "";
  const runtimeReferenceLimit = runtimeState.provider === "mock"
    ? MAX_DIRECTOR_VISUAL_REFERENCES
    : Math.min(
        MAX_DIRECTOR_VISUAL_REFERENCES,
        Math.max(0, Number(runtimeState.capabilities?.maxSceneReferenceImages) || 0),
      );
  const runtimeReferenceConditioningReady = runtimeState.provider === "mock" || (
    runtimeState.capabilities?.referenceConditioning === true &&
    runtimeState.capabilities?.featureStatus?.referenceConditioning === "supported" &&
    runtimeReferenceLimit > 0
  );
  for (const scene of storyboard) {
    const sceneId = String(scene.id ?? "");
    const canonicalScene = projectSceneById.get(sceneId);
    if (!canonicalScene) {
      throw problem(
        400,
        "invalid_scene_job",
        "Generation scenes must belong to the saved project",
      );
    }
    if (targetedSceneId && sceneId !== targetedSceneId) {
      scene.referenceIds = [];
      continue;
    }
    const explicitIds = new Set(
      Array.isArray(canonicalScene.referenceIds)
        ? canonicalScene.referenceIds.map(String)
        : [],
    );
    const selectedIds = [...supportedReferences.entries()]
      .filter(([id, reference]) => {
        const sceneIds = Array.isArray(reference.sceneIds)
          ? reference.sceneIds.map(String)
          : [];
        return explicitIds.has(id) || sceneIds.length === 0 || sceneIds.includes(sceneId);
      })
      .map(([id]) => id)
      .sort();
    if (runtimeReferenceConditioningReady && selectedIds.length > runtimeReferenceLimit) {
      throw problem(
        400,
        "reference_limit_exceeded",
        `The connected runtime supports at most ${runtimeReferenceLimit} visual references per scene`,
      );
    }
    scene.referenceIds = selectedIds;
    selectedIds.forEach((id) => {
      const sceneIds = selectedSceneIdsByReference.get(id) ?? new Set<string>();
      sceneIds.add(sceneId);
      selectedSceneIdsByReference.set(id, sceneIds);
    });
  }

  if (
    selectedSceneIdsByReference.size > 0 &&
    !runtimeReferenceConditioningReady
  ) {
    throw problem(
      409,
      "capability_unavailable",
      "The connected runtime has not verified visual reference conditioning",
    );
  }

  let totalBytes = 0;
  const snapshots: StoredGenerationReferenceSnapshot[] = [];
  for (const id of [...selectedSceneIdsByReference.keys()].sort()) {
    const reference = supportedReferences.get(id)!;
    const assetId = String(reference.assetId);
    const asset = await findAsset(assetId);
    if (
      !asset ||
      asset.uid !== uid ||
      !asset.uploadedAt ||
      asset.purpose !== "reference"
    ) {
      throw problem(
        403,
        "reference_forbidden",
        "A generation reference asset is not owned by the caller",
      );
    }
    const normalized = await ensureNormalizedReference(asset);
    totalBytes += normalized.byteLength;
    if (totalBytes > MAX_DIRECTOR_VISUAL_BYTES) {
      throw problem(
        400,
        "reference_limit_exceeded",
        "Generation references exceed the allowed aggregate size",
      );
    }
    snapshots.push({
      id,
      type: String(reference.type) as StoredGenerationReferenceSnapshot["type"],
      version: Math.min(1_000, Math.max(1, Math.round(Number(reference.version) || 1))),
      assetId,
      normalizedSha256: normalized.sha256,
      normalizedByteLength: normalized.byteLength,
      sceneIds: [...selectedSceneIdsByReference.get(id)!].sort(),
    });
  }
  return snapshots;
}

async function hydrateGenerationReferences(
  g: StoredGeneration,
): Promise<NonNullable<RuntimeVideoSettings["referenceConditioning"]>> {
  const snapshots = g.referenceSnapshot ?? [];
  const references: NonNullable<RuntimeVideoSettings["referenceConditioning"]> = [];
  let totalBytes = 0;
  for (const snapshot of snapshots) {
    const asset = await findAsset(snapshot.assetId);
    if (
      !asset ||
      asset.uid !== g.uid ||
      !asset.uploadedAt ||
      asset.purpose !== "reference"
    ) {
      throw new Error("reference_snapshot_unavailable");
    }
    const normalized = await ensureNormalizedReference(asset);
    if (
      normalized.sha256 !== snapshot.normalizedSha256 ||
      normalized.byteLength !== snapshot.normalizedByteLength
    ) {
      throw new Error("reference_snapshot_changed");
    }
    totalBytes += normalized.byteLength;
    if (totalBytes > MAX_DIRECTOR_VISUAL_BYTES) {
      throw new Error("reference_snapshot_too_large");
    }
    references.push({
      id: snapshot.id,
      type: snapshot.type,
      version: snapshot.version,
      imageBase64: `data:${normalized.contentType};base64,${normalized.bytes.toString("base64")}`,
      sceneIds: [...snapshot.sceneIds],
    });
  }
  return references;
}
async function uploadedAssetDataUrl(objectPath: string, uid: string) {
  if (!isOwnedUploadPath(objectPath, uid))
    throw problem(403, "asset_forbidden", "Asset is not owned by caller");
  if (localAuth) {
    const asset = [...assets.values()].find(
      (candidate) =>
        candidate.uid === uid && candidate.objectPath === objectPath,
    );
    if (!asset?.bytes)
      throw problem(404, "asset_not_found", "Uploaded asset was not found");
    return `data:${asset.contentType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
  }
  adminApp();
  const file = getStorage().bucket().file(objectPath);
  const [[metadata], [bytes]] = await Promise.all([
    file.getMetadata(),
    file.download(),
  ]);
  const contentType =
    typeof metadata.contentType === "string" &&
    metadata.contentType.startsWith("image/")
      ? metadata.contentType
      : "image/png";
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}
async function hydrateAssetReferences(
  value: unknown,
  uid: string,
): Promise<unknown> {
  if (Array.isArray(value))
    return Promise.all(value.map((item) => hydrateAssetReferences(item, uid)));
  if (!value || typeof value !== "object") return value;
  const hydrated = Object.fromEntries(
    await Promise.all(
      Object.entries(value as Record<string, unknown>).map(
        async ([key, nested]) => [
          key,
          await hydrateAssetReferences(nested, uid),
        ],
      ),
    ),
  );
  await Promise.all(
    Object.entries(base64FieldByObjectPathField).map(
      async ([objectPathField, base64Field]) => {
        const objectPath = hydrated[objectPathField];
        if (
          typeof objectPath === "string" &&
          typeof hydrated[base64Field] !== "string"
        )
          hydrated[base64Field] = await uploadedAssetDataUrl(objectPath, uid);
      },
    ),
  );
  return hydrated;
}

type PortableAssemblySource = {
  url: string;
  contentType: "video/mp4" | "video/webm";
  sizeBytes: number;
  sha256: string;
};

async function portableAssemblySource(
  generation: StoredGeneration,
): Promise<PortableAssemblySource> {
  if (
    !generation.outputContentType ||
    !["video/mp4", "video/webm"].includes(generation.outputContentType)
  )
    throw new Error("invalid_assembly_sources");
  const contentType =
    generation.outputContentType as PortableAssemblySource["contentType"];
  const maximumBytes = Math.max(
    1,
    Number(
      process.env.VIDEO_LAB_ASSEMBLY_SOURCE_MAX_BYTES ??
        160 * 1024 * 1024,
    ),
  );
  if (localAuth) {
    const bytes = generation.outputBytes;
    if (!bytes?.byteLength || bytes.byteLength > maximumBytes)
      throw new Error("invalid_assembly_sources");
    return {
      url: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  if (
    !generation.outputObjectPath ||
    !generation.outputObjectPath.startsWith(
      `users/${generation.uid}/outputs/`,
    )
  )
    throw new Error("invalid_assembly_sources");
  adminApp();
  const file = getStorage().bucket().file(generation.outputObjectPath);
  const [metadata] = await file.getMetadata();
  const sizeBytes = Number(metadata.size);
  if (
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > maximumBytes
  )
    throw new Error("invalid_assembly_sources");
  let sha256 = generation.outputSha256;
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    const [bytes] = await file.download();
    if (bytes.byteLength !== sizeBytes || bytes.byteLength > maximumBytes)
      throw new Error("invalid_assembly_sources");
    sha256 = createHash("sha256").update(bytes).digest("hex");
    generation.outputSha256 = sha256;
    await persistGeneration(generation);
  }
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 15 * 60_000,
  });
  return { url, contentType, sizeBytes, sha256 };
}

async function runtimeGeneration(
  g: StoredGeneration,
): Promise<RuntimeGenerationInput> {
  const hydrated = (await hydrateAssetReferences(
    g.settings,
    g.uid,
  )) as Generation["settings"];
  const settings = { ...hydrated } as Generation["settings"] & {
    acceptedSceneGenerationIds?: unknown;
    assemblyJobIds?: string[];
    assemblySources?: PortableAssemblySource[];
  };
  const referenceConditioning = await hydrateGenerationReferences(g);
  settings.referenceConditioning = referenceConditioning;
  if (Array.isArray(settings.storyboard)) {
    const allowedByScene = new Map<string, string[]>();
    referenceConditioning.forEach((reference) => {
      reference.sceneIds.forEach((sceneId) => {
        const ids = allowedByScene.get(sceneId) ?? [];
        ids.push(reference.id);
        allowedByScene.set(sceneId, ids);
      });
    });
    settings.storyboard = settings.storyboard.map((scene) => ({
      ...(scene as Record<string, unknown>),
      referenceIds: [...new Set(allowedByScene.get(String((scene as { id?: unknown }).id ?? "")) ?? [])].sort(),
    })) as typeof settings.storyboard;
  }
  if (settings.operationScope === "assembly") {
    const acceptedIds = settings.acceptedSceneGenerationIds;
    const storyboard = Array.isArray(settings.storyboard)
      ? settings.storyboard
      : [];
    if (
      !Array.isArray(acceptedIds) ||
      acceptedIds.length !== storyboard.length
    ) {
      throw new Error("invalid_assembly_sources");
    }
    const assemblySources: PortableAssemblySource[] = [];
    for (let index = 0; index < acceptedIds.length; index += 1) {
      const generationId = String(acceptedIds[index] ?? "");
      const accepted = await findGeneration(generationId);
      const expectedSceneId = String(
        (storyboard[index] as { id?: unknown } | undefined)?.id ?? "",
      );
      if (
        !accepted ||
        accepted.uid !== g.uid ||
        accepted.status !== "completed" ||
        accepted.settings.operationScope !== "scene" ||
        accepted.settings.operationSceneId !== expectedSceneId ||
        accepted.settings.projectId !== settings.projectId ||
        !accepted.output
      ) {
        throw new Error("invalid_assembly_sources");
      }
      assemblySources.push(await portableAssemblySource(accepted));
    }
    settings.storyboard = storyboard.map((scene) => {
      const duration = Number((scene as { duration?: unknown }).duration);
      return {
        ...(scene as Record<string, unknown>),
        trimStart: 0,
        trimEnd: Number.isFinite(duration) ? duration : undefined,
      };
    });
    settings.durationSeconds = storyboard.reduce((total, scene) => {
      const duration = Number((scene as { duration?: unknown }).duration);
      return total + (Number.isFinite(duration) ? duration : 0);
    }, 0);
    settings.assemblySources = assemblySources;
    delete settings.assemblyJobIds;
    delete settings.acceptedSceneGenerationIds;
  }
  return {
    prompt: g.prompt,
    settings,
    inputAssetUrls: [],
    idempotencyKey:
      settings.operationScope === "assembly"
        ? `video-lab:${g.id}:assembly-attempt-${Math.max(1, g.assemblyRuntimeAttempt ?? 1)}`
        : `video-lab:${g.id}`,
  };
}
export function localAuthEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production") return false;
  return env.NODE_ENV === "test" || env.VIDEO_LAB_LOCAL_AUTH === "true";
}
const localAuth = localAuthEnabled();
const usesIntelligensiRuntimeApi =
  process.env.VIDEO_RUNTIME_PROVIDER === "intelligensi-api";
function videoLabRuntimeApiKey() {
  return (
    process.env.VIDEO_LAB_RUNTIME_API_KEY ??
    process.env.VIDEO_RUNTIME_API_TOKEN
  );
}
function normalizeRuntimeBaseUrl(value: unknown) {
  const origin = normalizeRuntimeOrigin(value, {
    production: process.env.NODE_ENV === "production",
    allowPrivate: localAuth,
  });
  return origin && runtimeOriginAllowed(origin) ? origin : undefined;
}
const configuredRuntimeBaseUrl = normalizeRuntimeBaseUrl(
  process.env.VIDEO_RUNTIME_BASE_URL,
);
let runtimeBaseUrl = configuredRuntimeBaseUrl;
type PublicRuntimeDiscovery = NonNullable<RuntimeStatus["discovery"]>;
type RuntimeDiscovery = PublicRuntimeDiscovery & { baseUrl?: string };
let runtimeDiscovery: RuntimeDiscovery = {
  source: runtimeBaseUrl ? "environment" : "none",
  state: runtimeBaseUrl ? "waiting" : "unavailable",
  message: runtimeBaseUrl
    ? usesIntelligensiRuntimeApi
      ? "Configured through the stable Deploy Studio runtime API"
      : "Configured from the server environment"
    : "Waiting for Deploy Studio",
};
let runtimeDiscoveryCheckedAt = 0;
let runtimeDiscoveryPromise: Promise<void> | undefined;
const runtimeDiscoveryRefreshMs = boundedInteger(
  process.env.VIDEO_RUNTIME_DISCOVERY_REFRESH_MS,
  10_000,
  2_000,
  5 * 60_000,
);
let manualRuntimeBaseUrl: string | undefined;
export function creditLimitsEnabled(_env: NodeJS.ProcessEnv = process.env) {
  return false;
}
const adminEmails = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
export function firebaseStorageBucket(env: NodeJS.ProcessEnv = process.env) {
  if (env.FIREBASE_STORAGE_BUCKET?.trim())
    return env.FIREBASE_STORAGE_BUCKET.trim();
  try {
    const config = JSON.parse(env.FIREBASE_CONFIG ?? "{}") as {
      storageBucket?: unknown;
    };
    if (typeof config.storageBucket === "string" && config.storageBucket.trim())
      return config.storageBucket.trim();
  } catch {
    /* Fall through to the project-derived bucket. */
  }
  const projectId = env.GCLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
  return projectId ? `${projectId}.firebasestorage.app` : undefined;
}
function adminApp() {
  if (!getApps().length)
    initializeApp({
      credential: applicationDefault(),
      storageBucket: firebaseStorageBucket(),
    });
}
function createRuntimeAdapter(
  baseUrl: string,
  mode: "configured" | "direct-worker" = "configured",
) {
  const directWorker = mode === "direct-worker";
  return new SulphurLtxRuntimeAdapter({
    baseUrl,
    token: directWorker
      ? process.env.VIDEO_RUNTIME_DIRECT_WORKER_TOKEN ??
        videoLabRuntimeApiKey()
      : videoLabRuntimeApiKey(),
    runtimeId:
      process.env.VIDEO_RUNTIME_ID ?? "longform-ltx-storyboard-studio",
    healthPath: directWorker
      ? "/health"
      : usesIntelligensiRuntimeApi
        ? process.env.VIDEO_RUNTIME_HEALTH_PATH
        : process.env.VIDEO_RUNTIME_HEALTH_PATH ?? "/health",
    submitPath: process.env.VIDEO_RUNTIME_SUBMIT_PATH,
    statusPath: process.env.VIDEO_RUNTIME_STATUS_PATH,
    cancelPath: process.env.VIDEO_RUNTIME_CANCEL_PATH,
    outputPath: process.env.VIDEO_RUNTIME_OUTPUT_PATH,
    authHeaderName: directWorker
      ? (process.env.VIDEO_RUNTIME_DIRECT_WORKER_AUTH_HEADER ??
        "authorization")
      : process.env.VIDEO_RUNTIME_AUTH_HEADER,
    authScheme: directWorker
      ? (process.env.VIDEO_RUNTIME_DIRECT_WORKER_AUTH_SCHEME ?? "Bearer")
      : process.env.VIDEO_RUNTIME_AUTH_SCHEME,
    payloadMode: directWorker
      ? "deploy-studio"
      : usesIntelligensiRuntimeApi
        ? "intelligensi-api"
        : process.env.VIDEO_RUNTIME_PAYLOAD_MODE === "sulphur"
          ? "sulphur"
          : "deploy-studio",
    timeoutMs: boundedInteger(
      process.env.VIDEO_RUNTIME_TIMEOUT_MS,
      120_000,
      1_000,
      15 * 60_000,
    ),
  });
}
async function connectRuntimeEndpoint(
  baseUrl: string,
  source: RuntimeDiscovery["source"],
  message: string,
) {
  if (!runtimeOriginAllowed(baseUrl)) {
    throw problem(
      400,
      "runtime_origin_not_allowed",
      "Runtime origin is not in the allowed production allow-list",
    );
  }
  const adapter = createRuntimeAdapter(
    baseUrl,
    source === "environment" ? "direct-worker" : "configured",
  );
  let health: Awaited<ReturnType<SulphurLtxRuntimeAdapter["healthCheck"]>>;
  try {
    health = await adapter.healthCheck();
  } catch (e) {
    log("runtime_health_unreachable", {
      source,
      errorCode: operationalErrorCode(e),
    });
    throw problem(
      503,
      "runtime_health_unreachable",
      "Could not reach the managed generation runtime. Verify the server-side runtime connection and try again.",
    );
  }
  if (!health.ok)
    throw problem(
      503,
      "runtime_health_failed",
      "Runtime health check did not report ready",
    );
  if (source === "environment") {
    const protectedAccess = await adapter.verifyProtectedAccess();
    if (!protectedAccess.ok)
      throw problem(
        401,
        "runtime_access_denied",
        "Runtime health is ready, but protected generation routes rejected the server connection. Verify server-side runtime credentials or connect through Deploy Studio.",
      );
  }
  runtimeBaseUrl = baseUrl;
  runtime = adapter;
  runtimeDiscovery = { source, state: "connected", baseUrl, message };
  runtimeState = {
    ...runtimeState,
    provider: health.provider,
    status: "healthy",
    acceptingSubmissions: true,
    killSwitch: false,
    lastHeartbeatAt: nowIso(),
    updatedAt: nowIso(),
  };
  log("runtime_endpoint_connected", { source });
}
function discoveryDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  )
    return (value as { toDate: () => Date }).toDate();
  return undefined;
}
function useRuntimeEndpoint(
  baseUrl: string,
  source: RuntimeDiscovery["source"],
  mode: "configured" | "direct-worker" = "configured",
) {
  if (runtimeBaseUrl !== baseUrl) {
    runtimeBaseUrl = baseUrl;
    runtime = createRuntimeAdapter(baseUrl, mode);
    log("runtime_endpoint_discovered", { source });
  }
  if (runtimeState.provider === "mock")
    runtimeState = {
      ...runtimeState,
      provider: usesIntelligensiRuntimeApi
        ? "intelligensi-api"
        : "sulphur-ltx",
      updatedAt: nowIso(),
    };
}
function clearRuntimeEndpoint(discovery: RuntimeDiscovery) {
  runtimeBaseUrl = undefined;
  runtimeDiscovery = discovery;
  if (runtimeState.status !== "paused" && !runtimeState.killSwitch)
    runtimeState = {
      ...runtimeState,
      status: "unavailable",
      acceptingSubmissions: false,
      updatedAt: nowIso(),
    };
}
async function loadRuntimeDiscovery(force = false) {
  const expectedRuntimeId =
    process.env.VIDEO_RUNTIME_ID ?? "longform-ltx-storyboard-studio";
  const gatewayBaseUrl = usesIntelligensiRuntimeApi
    ? configuredRuntimeBaseUrl
    : undefined;
  if (gatewayBaseUrl) {
    if (manualRuntimeBaseUrl) {
      runtimeDiscoveryCheckedAt = Date.now();
      useRuntimeEndpoint(manualRuntimeBaseUrl, "environment", "direct-worker");
      runtimeDiscovery = {
        source: "environment",
        state: "connected",
        baseUrl: manualRuntimeBaseUrl,
        message:
          "Manual admin runtime connection is active until Deploy Studio publishes a healthy handover",
      };
      if (runtimeState.status !== "paused" && !runtimeState.killSwitch)
        runtimeState = {
          ...runtimeState,
          status: "healthy",
          acceptingSubmissions: true,
          updatedAt: nowIso(),
        };
      return;
    }
    let discovered:
      | Awaited<ReturnType<SulphurLtxRuntimeAdapter["discoverReadyRuntime"]>>
      | undefined;
    const gatewayRuntime =
      runtimeBaseUrl === gatewayBaseUrl && runtime instanceof SulphurLtxRuntimeAdapter
        ? runtime
        : createRuntimeAdapter(gatewayBaseUrl);
    if (gatewayRuntime instanceof SulphurLtxRuntimeAdapter) {
      try {
        discovered = await gatewayRuntime.discoverReadyRuntime(
          "storyboard-enhance",
        );
      } catch (error) {
        log("runtime_gateway_discovery_failed", {
          errorCode: operationalErrorCode(error),
        });
      }
    }
    if (discovered) {
      runtimeDiscoveryCheckedAt = Date.now();
      useRuntimeEndpoint(gatewayBaseUrl, "deploy-studio");
      runtimeDiscovery = {
        source: "deploy-studio",
        state: "connected",
        message: `Connected through Deploy Studio runtime API (${discovered.runtimeId})`,
      };
      return;
    }
  }
  if (localAuth) return;
  const now = Date.now();
  if (!force && now - runtimeDiscoveryCheckedAt < runtimeDiscoveryRefreshMs)
    return;
  if (runtimeDiscoveryPromise) return runtimeDiscoveryPromise;
  runtimeDiscoveryPromise = (async () => {
    adminApp();
    const firestore = getFirestore();
    const discoveryCollection =
      process.env.VIDEO_RUNTIME_DISCOVERY_COLLECTION ?? "runtimeDiscovery";
    const configuredDiscoveryDocument =
      process.env.VIDEO_RUNTIME_DISCOVERY_DOCUMENT ?? "current";
    const discoveryDocumentIds = Array.from(
      new Set([configuredDiscoveryDocument, expectedRuntimeId, "current"]),
    );
    const snapshots = await Promise.all(
      discoveryDocumentIds.map((documentId) =>
        firestore.collection(discoveryCollection).doc(documentId).get(),
      ),
    );
    const snapshot = snapshots.find((item) => item.exists);
    runtimeDiscoveryCheckedAt = Date.now();
    if (snapshot?.exists) {
      const data = snapshot.data() ?? {};
      const status = String(data.status ?? "").toLowerCase();
      const baseUrl = normalizeRuntimeBaseUrl(data.baseUrl);
      const heartbeatAt = discoveryDate(data.heartbeatAt);
      const leaseExpiresAt = discoveryDate(data.leaseExpiresAt);
      const details = {
        source: "deploy-studio" as const,
        lastPublishedAt: heartbeatAt?.toISOString(),
        leaseExpiresAt: leaseExpiresAt?.toISOString(),
      };
      if (status !== "ready") {
        if (manualRuntimeBaseUrl) {
          useRuntimeEndpoint(manualRuntimeBaseUrl, "environment", "direct-worker");
          runtimeDiscovery = {
            source: "environment",
            state: "connected",
            baseUrl: manualRuntimeBaseUrl,
            message:
              "Manual admin runtime connection remains active while Deploy Studio reports an unhealthy handover",
          };
          return;
        }
        clearRuntimeEndpoint({
          ...details,
          state: "waiting",
          message: `Deploy Studio reports ${status || "no status"}`,
        });
        return;
      }
      if (!baseUrl) {
        if (manualRuntimeBaseUrl) {
          useRuntimeEndpoint(manualRuntimeBaseUrl, "environment", "direct-worker");
          runtimeDiscovery = {
            source: "environment",
            state: "connected",
            baseUrl: manualRuntimeBaseUrl,
            message:
              "Manual admin runtime connection remains active while Deploy Studio handover is incomplete",
          };
          return;
        }
        clearRuntimeEndpoint({
          ...details,
          state: "unavailable",
          message: "Deploy Studio did not publish a valid runtime origin",
        });
        return;
      }
      if (!leaseExpiresAt || leaseExpiresAt.getTime() <= Date.now()) {
        clearRuntimeEndpoint({
          ...details,
          state: "stale",
          message:
            "Deploy Studio runtime lease expired; waiting for a fresh handover",
        });
        return;
      }
      const worker = typeof data.worker === "string" ? data.worker : "";
      if (worker !== "longform-ltx-storyboard-studio") {
        clearRuntimeEndpoint({
          ...details,
          state: "unavailable",
          message: "Deploy Studio published an unsupported runtime",
        });
        return;
      }
      useRuntimeEndpoint(baseUrl, "deploy-studio");
      manualRuntimeBaseUrl = undefined;
      runtimeDiscovery = {
        ...details,
        state: "connected",
        message: "Managed LongForm runtime is connected",
      };
      return;
    }
    const allowFallback =
      localAuth || process.env.VIDEO_RUNTIME_ALLOW_ENV_FALLBACK === "true";
    const environmentUrl = allowFallback
      ? normalizeRuntimeBaseUrl(process.env.VIDEO_RUNTIME_BASE_URL)
      : undefined;
    if (environmentUrl) {
      useRuntimeEndpoint(environmentUrl, "environment");
      runtimeDiscovery = {
        source: "environment",
        state: "connected",
        baseUrl: environmentUrl,
        message: "Using server environment fallback",
      };
      return;
    }
    const legacy = allowFallback
      ? await firestore.collection("runtimeState").doc("config").get()
      : undefined;
    const legacyUrl = legacy?.exists
      ? normalizeRuntimeBaseUrl(legacy.data()?.baseUrl)
      : undefined;
    if (legacyUrl) {
      useRuntimeEndpoint(legacyUrl, "legacy");
      runtimeDiscovery = {
        source: "legacy",
        state: "connected",
        baseUrl: legacyUrl,
        message:
          "Using migration fallback until Deploy Studio publishes a lease",
      };
      return;
    }
    clearRuntimeEndpoint({
      source: "none",
      state: "unavailable",
      message: "Waiting for Deploy Studio to publish a runtime lease",
    });
  })()
    .catch((error) => {
      runtimeDiscoveryCheckedAt = Date.now();
      clearRuntimeEndpoint({
        source: "none",
        state: "unavailable",
        message: "Runtime discovery could not be refreshed",
      });
      log("runtime_discovery_failed", {
        errorCode: operationalErrorCode(error),
      });
      throw error;
    })
    .finally(() => {
      runtimeDiscoveryPromise = undefined;
    });
  return runtimeDiscoveryPromise;
}
async function ensureRuntimeConfiguration() {
  if (!localAuth && Date.now() - runtimeControlCheckedAt > 5_000) {
    adminApp();
    const control = await getFirestore()
      .collection("runtimeState")
      .doc("control")
      .get();
    runtimeControlCheckedAt = Date.now();
    if (control.exists) {
      const data = control.data() ?? {};
      const controlManualBaseUrl = normalizeRuntimeBaseUrl(
        data.manualRuntimeBaseUrl,
      );
      if (controlManualBaseUrl && controlManualBaseUrl !== manualRuntimeBaseUrl)
        manualRuntimeBaseUrl = controlManualBaseUrl;
      if (data.killSwitch === true) {
        runtimeState = {
          ...runtimeState,
          killSwitch: true,
          acceptingSubmissions: false,
          status: "unavailable",
        };
      } else if (data.status === "paused") {
        runtimeState = {
          ...runtimeState,
          killSwitch: false,
          acceptingSubmissions: false,
          status: "paused",
        };
      } else {
        runtimeState = { ...runtimeState, killSwitch: false };
      }
      if (manualRuntimeBaseUrl && runtimeState.status !== "paused") {
        useRuntimeEndpoint(manualRuntimeBaseUrl, "environment", "direct-worker");
        runtimeDiscovery = {
          source: "environment",
          state: "connected",
          baseUrl: manualRuntimeBaseUrl,
          message:
            "Manual admin runtime connection is active until Deploy Studio publishes a healthy handover",
        };
      }
    }
  }
  await loadRuntimeDiscovery();
}
async function persistRuntimeControl(principal: Principal, action: string) {
  if (!localAuth) {
    adminApp();
    await getFirestore().collection("runtimeState").doc("control").set({
      status: runtimeState.status,
      acceptingSubmissions: runtimeState.acceptingSubmissions,
      killSwitch: runtimeState.killSwitch,
      manualRuntimeBaseUrl: manualRuntimeBaseUrl ?? null,
      updatedAt: nowIso(),
      updatedBy: principal.uid,
    });
    runtimeControlCheckedAt = Date.now();
  }
  await recordAdminAudit(principal, action);
}
async function recordAdminAudit(principal: Principal, action: string) {
  if (!localAuth) {
    adminApp();
    await getFirestore().collection("adminAudit").add({
      action,
      actorUid: principal.uid,
      createdAt: nowIso(),
      requestSafe: true,
    });
  }
  log("admin_action", { action, actorUid: principal.uid });
}
async function refreshRuntimeHealth() {
  if (
    !runtimeBaseUrl ||
    runtimeState.provider === "mock" ||
    runtimeState.killSwitch ||
    runtimeState.status === "paused" ||
    (usesIntelligensiRuntimeApi && runtimeDiscovery.state !== "connected")
  )
    return;
  try {
    const health = await runtime.healthCheck();
    const protectedAccess =
      runtimeDiscovery.source === "environment" &&
      runtime instanceof SulphurLtxRuntimeAdapter
        ? await runtime.verifyProtectedAccess()
        : undefined;
    if (protectedAccess && !protectedAccess.ok) {
      runtimeState = {
        ...runtimeState,
        provider: health.provider,
        status: "unavailable",
        acceptingSubmissions: false,
        capabilities: health.capabilities ?? runtimeState.capabilities,
        updatedAt: nowIso(),
      };
      runtimeDiscovery = {
        ...runtimeDiscovery,
        state: "unavailable",
        message:
          "Manual runtime health is ready, but protected generation routes rejected the server connection.",
      };
      return;
    }
    runtimeState = {
      ...runtimeState,
      provider: health.provider,
      status: health.ok ? "healthy" : "unavailable",
      acceptingSubmissions: health.ok,
      lastHeartbeatAt: health.ok ? nowIso() : runtimeState.lastHeartbeatAt,
      capabilities: health.capabilities ?? runtimeState.capabilities,
      updatedAt: nowIso(),
    };
  } catch (e) {
    runtimeState = {
      ...runtimeState,
      status: "unavailable",
      acceptingSubmissions: false,
      updatedAt: nowIso(),
    };
    log("runtime_health_failed", {
      errorCode: operationalErrorCode(e),
    });
  }
}
function publicRuntimeStatus(): RuntimeStatus {
  const { baseUrl: _privateRuntimeOrigin, ...publicDiscovery } =
    runtimeDiscovery;
  return {
    ...runtimeState,
    provider: runtimeState.provider === "mock" ? "mock" : "managed-longform",
    queueDepth: localAuth
      ? queue.filter((q) => q.status !== "done").length
      : runtimeState.queueDepth,
    discovery: publicDiscovery,
  };
}
function publicRuntimeProgress(st: Awaited<ReturnType<typeof runtime.getGenerationStatus>>) {
  const runtimeProgress = {
    ...(typeof st.framesRendered === "number"
      ? { framesRendered: st.framesRendered }
      : {}),
    ...(typeof st.totalFrames === "number" ? { totalFrames: st.totalFrames } : {}),
    ...(typeof st.currentScene === "number" ? { currentScene: st.currentScene } : {}),
    ...(typeof st.totalScenes === "number" ? { totalScenes: st.totalScenes } : {}),
    ...(typeof st.stage === "string" ? { stage: st.stage } : {}),
  };
  return Object.keys(runtimeProgress).length ? runtimeProgress : undefined;
}
async function persistGeneration(g: StoredGeneration) {
  if (localAuth) return;
  adminApp();
  const clean = storedGenerationRecord(g);
  await getFirestore()
    .collection("generations")
    .doc(g.id)
    .set(clean);
}
async function findGeneration(id: string) {
  const memory = gens.get(id);
  if (memory || localAuth) return memory;
  adminApp();
  const snapshot = await getFirestore().collection("generations").doc(id).get();
  if (!snapshot.exists) return undefined;
  const generation = snapshot.data() as StoredGeneration;
  gens.set(id, generation);
  return generation;
}

function publicGenerationEdit(edit: StoredGenerationEdit) {
  const {
    uid: _uid,
    outputBytes: _outputBytes,
    outputObjectPath: _outputObjectPath,
    outputSha256: _outputSha256,
    ...publicEdit
  } = edit;
  return publicEdit;
}

async function persistGenerationEdit(edit: StoredGenerationEdit) {
  generationEdits.set(edit.id, edit);
  if (localAuth) return;
  adminApp();
  const { outputBytes: _outputBytes, ...stored } = edit;
  await getFirestore().collection("generationEdits").doc(edit.id).set(stored);
}

async function findGenerationEdit(id: string) {
  const memory = generationEdits.get(id);
  if (memory || localAuth) return memory;
  adminApp();
  const snapshot = await getFirestore().collection("generationEdits").doc(id).get();
  if (!snapshot.exists) return undefined;
  const edit = snapshot.data() as StoredGenerationEdit;
  generationEdits.set(id, edit);
  return edit;
}

async function deleteStoredGeneration(g: StoredGeneration) {
  gens.delete(g.id);
  let editsToDelete = [...generationEdits.values()].filter(
    (edit) => edit.generationId === g.id,
  );
  editsToDelete.forEach((edit) => generationEdits.delete(edit.id));
  const queueIndex = queue.findIndex((item) => item.generationId === g.id);
  if (queueIndex >= 0) queue.splice(queueIndex, 1);
  for (const [key, generationId] of idempotency.entries()) {
    if (generationId === g.id) idempotency.delete(key);
  }
  if (localAuth) return;
  adminApp();
  const firestore = getFirestore();
  const editSnapshot = await firestore
    .collection("generationEdits")
    .where("generationId", "==", g.id)
    .where("uid", "==", g.uid)
    .get();
  editsToDelete = [
    ...editsToDelete,
    ...editSnapshot.docs
      .map((doc) => doc.data() as StoredGenerationEdit)
      .filter(
        (edit) =>
          !editsToDelete.some((cachedEdit) => cachedEdit.id === edit.id),
      ),
  ];
  const writes: Promise<unknown>[] = [
    firestore.collection("generations").doc(g.id).delete(),
    firestore.collection(generationQueueCollection).doc(g.id).delete(),
  ];
  const activeRef = firestore.collection(generationActiveCollection).doc(g.uid);
  const activeSnapshot = await activeRef.get();
  if (activeSnapshot.data()?.generationId === g.id) writes.push(activeRef.delete());
  if (g.outputObjectPath) {
    writes.push(
      getStorage()
        .bucket()
        .file(g.outputObjectPath)
        .delete({ ignoreNotFound: true }),
    );
  }
  editsToDelete.forEach((edit) => {
    writes.push(firestore.collection("generationEdits").doc(edit.id).delete());
    if (edit.outputObjectPath) {
      writes.push(
        getStorage()
          .bucket()
          .file(edit.outputObjectPath)
          .delete({ ignoreNotFound: true }),
      );
    }
  });
  await Promise.all(writes);
}

async function readGenerationOutputBytes(g: StoredGeneration) {
  if (g.outputBytes) return Buffer.from(g.outputBytes);
  if (!g.outputObjectPath)
    throw problem(
      404,
      "output_not_available",
      "Generation output is not available for editing",
    );
  adminApp();
  const file = getStorage().bucket().file(g.outputObjectPath);
  const [exists] = await file.exists();
  if (!exists)
    throw problem(
      404,
      "output_not_available",
      "Generation output is not available for editing",
    );
  const [bytes] = await file.download();
  return bytes;
}

function parseTrimSeconds(value: unknown, field: string) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60 * 60) {
    throw problem(400, "invalid_trim", `${field} must be a valid timestamp`);
  }
  return Math.round(seconds * 1000) / 1000;
}

async function createTrimmedMp4(
  sourceBytes: Buffer,
  startSeconds: number,
  endSeconds: number,
) {
  const workDir = await fsp.mkdtemp(path.join(tmpdir(), "video-lab-trim-"));
  const sourcePath = path.join(workDir, "source.mp4");
  const outputPath = path.join(workDir, "trimmed.mp4");
  try {
    await fsp.writeFile(sourcePath, sourceBytes);
    const ffmpeg = process.env.FFMPEG_PATH || packagedFfmpeg.path || "ffmpeg";
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourcePath,
        "-ss",
        startSeconds.toFixed(3),
        "-to",
        endSeconds.toFixed(3),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    return await fsp.readFile(outputPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("generation_edit_trim_failed", { message });
    throw problem(
      500,
      "trim_failed",
      "The video could not be trimmed. Verify FFmpeg is available and try again.",
    );
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

function idempotencyDocumentId(uid: string, key: string) {
  return createHash("sha256").update(`${uid}\0${key}`).digest("hex");
}

async function findIdempotentGeneration(
  uid: string,
  key: string,
): Promise<StoredGeneration | undefined> {
  const localId = idempotency.get(`${uid}_${key}`);
  if (localAuth) return localId ? gens.get(localId) : undefined;
  adminApp();
  const snapshot = await getFirestore()
    .collection(generationIdempotencyCollection)
    .doc(idempotencyDocumentId(uid, key))
    .get();
  const generationId = snapshot.exists
    ? String(snapshot.data()?.generationId ?? "")
    : "";
  return generationId ? findGeneration(generationId) : undefined;
}

function activeGenerationStatus(status: Generation["status"]) {
  return ["queued", "preparing", "generating", "uploading"].includes(status);
}

function outputExtension(contentType: StoredGeneration["outputContentType"]) {
  return contentType === "image/png"
    ? "png"
    : contentType === "image/jpeg"
      ? "jpg"
      : contentType === "image/webp"
        ? "webp"
        : contentType === "video/webm"
          ? "webm"
          : "mp4";
}

async function completeGenerationFromRuntime(
  generation: StoredGeneration,
  runtimeJobId: string,
  qualityAssessment?: Generation["qualityAssessment"],
) {
  const out = await runtime.fetchOutput(runtimeJobId);
  if (creditLimitsEnabled())
    wallets.set(
      generation.uid,
      chargeCredits(wallets.get(generation.uid)!, generation.creditCost),
    );
  const outputObjectPath = `users/${generation.uid}/outputs/${generation.id}.${outputExtension(out.contentType)}`;
  const outputSha256 = createHash("sha256").update(out.bytes).digest("hex");
  if (!localAuth) {
    adminApp();
    await getStorage()
      .bucket()
      .file(outputObjectPath)
      .save(Buffer.from(out.bytes), {
        resumable: false,
        contentType: out.contentType,
        metadata: {
          cacheControl: "private,no-store",
          metadata: { sha256: outputSha256 },
        },
      });
  }
  const completed: StoredGeneration = {
    ...generation,
    status: "completed",
    progress: 100,
    runtimeMessage: undefined,
    runtimeProgress: undefined,
    ...(qualityAssessment ? { qualityAssessment } : {}),
    output: {
      downloadUrl: `/api/v1/generations/${generation.id}/download`,
      durationSeconds: out.durationSeconds,
      contentType: out.contentType,
      kind: out.contentType.startsWith("image/") ? "frame" : "video",
    },
    ...(localAuth ? { outputBytes: out.bytes } : {}),
    outputObjectPath,
    outputContentType: out.contentType,
    outputSha256,
    updatedAt: nowIso(),
  };
  gens.set(generation.id, completed);
  await persistGeneration(completed);
  log("runtime_generation_completed", {
    generationId: generation.id,
    outputContentType: out.contentType,
    outputSha256,
  });
  return completed;
}

async function failGenerationFromRuntime(
  generation: StoredGeneration,
  safeErrorMessage: string,
) {
  const failed: StoredGeneration = {
    ...generation,
    status: "failed",
    safeErrorMessage,
    updatedAt: nowIso(),
  };
  gens.set(generation.id, failed);
  await persistGeneration(failed);
  return failed;
}

async function requireRuntimeCancellation(
  generation: StoredGeneration,
  action: "cancel" | "delete",
): Promise<"confirmed" | "accepted"> {
  if (!generation.runtimeJobId) return "confirmed";
  try {
    const result = await runtime.cancelGeneration(generation.runtimeJobId);
    if (result.cancelled) return "confirmed";
    if (result.accepted) return "accepted";
  } catch (error) {
    log(
      action === "delete"
        ? "runtime_cancel_before_delete_failed"
        : "runtime_cancel_failed",
      {
        generationId: generation.id,
        errorCode: operationalErrorCode(error),
      },
    );
  }
  throw problem(
    503,
    "runtime_cancel_unconfirmed",
    action === "delete"
      ? "Deletion was not completed because the active generation could not be stopped safely. Retry shortly; the project record is unchanged."
      : "Cancellation could not be confirmed by the generator. The job remains active; retry shortly.",
  );
}

async function reconcileActiveGeneration(uid: string) {
  const active = localAuth
    ? [...gens.values()].find(
        (generation) =>
          generation.uid === uid && activeGenerationStatus(generation.status),
      )
    : await (async () => {
        adminApp();
        const activeSnapshot = await getFirestore()
          .collection(generationActiveCollection)
          .doc(uid)
          .get();
        const activeId = String(activeSnapshot.data()?.generationId ?? "");
        return activeId ? findGeneration(activeId) : undefined;
      })();
  if (!active || !activeGenerationStatus(active.status) || !active.runtimeJobId)
    return active;

  try {
    const runtimeStatus = await runtime.getGenerationStatus(active.runtimeJobId);
    if (!["completed", "failed", "cancelled"].includes(runtimeStatus.state))
      return active;
    const terminal =
      runtimeStatus.state === "completed"
        ? await completeGenerationFromRuntime(active, active.runtimeJobId, runtimeStatus.qualityAssessment)
        : await failGenerationFromRuntime(
            active,
            runtimeStatus.state === "cancelled"
              ? "Cancelled by user"
              : "Generation failed safely. Please retry when the runtime is available.",
          );
    const q = queue.find((item) => item.generationId === active.id) ?? {
      generationId: active.id,
      createdAt: active.createdAt,
      status: "claimed" as const,
      attempt: 0,
    };
    await finishQueueItem(q, active.uid);
    await refreshQueueDepth();
    return terminal;
  } catch (error) {
    log("active_generation_reconcile_failed", {
      uid,
      generationId: active.id,
      errorCode: operationalErrorCode(error),
    });
    return active;
  }
}

async function enqueueGeneration(
  generation: StoredGeneration,
  idempotencyKey: string,
  queueLimit: number,
): Promise<{ generation: StoredGeneration; created: boolean }> {
  if (localAuth) {
    const outstanding = queue.filter((item) => item.status !== "done").length;
    if (outstanding >= queueLimit)
      throw problem(
        503,
        "generation_capacity_reached",
        "Generation capacity is temporarily full; please retry shortly",
      );
    generation.queuePosition = outstanding + 1;
    gens.set(generation.id, generation);
    queue.push({
      generationId: generation.id,
      createdAt: generation.createdAt,
      status: "queued",
      attempt: 0,
    });
    idempotency.set(`${generation.uid}_${idempotencyKey}`, generation.id);
    return { generation, created: true };
  }

  adminApp();
  const firestore = getFirestore();
  const generationRef = firestore.collection("generations").doc(generation.id);
  const queueRef = firestore
    .collection(generationQueueCollection)
    .doc(generation.id);
  const idempotencyRef = firestore
    .collection(generationIdempotencyCollection)
    .doc(idempotencyDocumentId(generation.uid, idempotencyKey));
  const activeRef = firestore
    .collection(generationActiveCollection)
    .doc(generation.uid);
  const metricsRef = firestore
    .collection("runtimeState")
    .doc(queueMetricsDocument);
  let replayId: string | undefined;

  await firestore.runTransaction(async (transaction) => {
    const [idempotencySnapshot, activeSnapshot, metricsSnapshot] =
      await Promise.all([
        transaction.get(idempotencyRef),
        transaction.get(activeRef),
        transaction.get(metricsRef),
      ]);
    if (idempotencySnapshot.exists) {
      replayId = String(idempotencySnapshot.data()?.generationId ?? "");
      return;
    }

    if (activeSnapshot.exists) {
      const activeId = String(activeSnapshot.data()?.generationId ?? "");
      if (activeId) {
        const activeGenerationSnapshot = await transaction.get(
          firestore.collection("generations").doc(activeId),
        );
        if (
          activeGenerationSnapshot.exists &&
          activeGenerationStatus(
            (activeGenerationSnapshot.data() as StoredGeneration).status,
          )
        ) {
          throw problem(
            409,
            "active_generation_exists",
            "Only one active generation is allowed",
          );
        }
      }
    }

    const outstanding = Number(metricsSnapshot.data()?.outstanding ?? 0);
    if (outstanding >= queueLimit)
      throw problem(
        503,
        "generation_capacity_reached",
        "Generation capacity is temporarily full; please retry shortly",
      );
    generation.queuePosition = outstanding + 1;
    const storedGeneration = storedGenerationRecord(generation);
    transaction.create(generationRef, storedGeneration);
    transaction.create(queueRef, {
      generationId: generation.id,
      uid: generation.uid,
      createdAt: generation.createdAt,
      status: "queued",
      attempt: 0,
    });
    transaction.create(idempotencyRef, {
      uid: generation.uid,
      generationId: generation.id,
      createdAt: generation.createdAt,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    transaction.set(activeRef, {
      uid: generation.uid,
      generationId: generation.id,
      createdAt: generation.createdAt,
    });
    transaction.set(
      metricsRef,
      { outstanding: outstanding + 1, updatedAt: nowIso() },
      { merge: true },
    );
  });

  if (replayId) {
    const replay = await findGeneration(replayId);
    if (replay?.uid === generation.uid)
      return { generation: replay, created: false };
    throw problem(409, "idempotency_conflict", "Request could not be replayed");
  }
  gens.set(generation.id, generation);
  runtimeState = {
    ...runtimeState,
    queueDepth: Math.max(0, runtimeState.queueDepth) + 1,
    updatedAt: nowIso(),
  };
  return { generation, created: true };
}

function runtimeJobTimeoutMs() {
  return boundedInteger(
    process.env.VIDEO_RUNTIME_JOB_TIMEOUT_MS,
    55 * 60_000,
    60_000,
    2 * 60 * 60_000,
  );
}

function queueLeaseMs() {
  const timeout = runtimeJobTimeoutMs();
  return Math.min(2 * 60 * 60_000, timeout + 5 * 60_000);
}

async function claimQueueItem(
  workerId: string,
): Promise<QueueItem | undefined> {
  if (localAuth) return claimNext(queue, workerId, new Date(), queueLeaseMs());
  adminApp();
  const firestore = getFirestore();
  const [queued, expired] = await Promise.all([
    firestore
      .collection(generationQueueCollection)
      .where("status", "==", "queued")
      .orderBy("createdAt", "asc")
      .limit(100)
      .get(),
    firestore
        .collection(generationQueueCollection)
        .where("status", "==", "claimed")
        .where("leaseExpiresAt", "<", nowIso())
        .orderBy("leaseExpiresAt", "asc")
        .limit(100)
        .get(),
  ]);
  for (const candidate of [...queued.docs, ...expired.docs]) {
    let claimed: QueueItem | undefined;
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(candidate.ref);
      if (!snapshot.exists) return;
      const item = snapshot.data() as QueueItem;
      const capacityReady =
        !item.capacityRetryAt ||
        new Date(item.capacityRetryAt).getTime() <= Date.now();
      const eligible =
        (item.status === "queued" && capacityReady) ||
        (item.status === "claimed" &&
          Boolean(item.leaseExpiresAt) &&
          new Date(item.leaseExpiresAt!).getTime() < Date.now());
      if (!eligible) return;
      claimed = {
        ...item,
        status: "claimed",
        claimedBy: workerId,
        attempt: Number(item.attempt ?? 0) + 1,
        leaseExpiresAt: new Date(Date.now() + queueLeaseMs()).toISOString(),
        capacityRetryAt: undefined,
      };
      transaction.update(candidate.ref, {
        status: claimed.status,
        claimedBy: claimed.claimedBy,
        attempt: claimed.attempt,
        leaseExpiresAt: claimed.leaseExpiresAt,
        capacityRetryAt: null,
      });
    });
    if (claimed) return claimed;
  }
  return undefined;
}

async function finishQueueItem(item: QueueItem, uid?: string) {
  if (localAuth) {
    item.status = "done";
    return;
  }
  adminApp();
  const firestore = getFirestore();
  const queueRef = firestore
    .collection(generationQueueCollection)
    .doc(item.generationId);
  const metricsRef = firestore
    .collection("runtimeState")
    .doc(queueMetricsDocument);
  const activeRef = uid
    ? firestore.collection(generationActiveCollection).doc(uid)
    : undefined;
  await firestore.runTransaction(async (transaction) => {
    const reads = [transaction.get(queueRef), transaction.get(metricsRef)];
    if (activeRef) reads.push(transaction.get(activeRef));
    const [queueSnapshot, metricsSnapshot, activeSnapshot] =
      await Promise.all(reads);
    if (queueSnapshot.exists && queueSnapshot.data()?.status !== "done") {
      transaction.update(queueRef, {
        status: "done",
        completedAt: nowIso(),
        leaseExpiresAt: null,
      });
      const outstanding = Number(metricsSnapshot.data()?.outstanding ?? 0);
      transaction.set(
        metricsRef,
        { outstanding: Math.max(0, outstanding - 1), updatedAt: nowIso() },
        { merge: true },
      );
    }
    if (
      activeRef &&
      activeSnapshot?.exists &&
      activeSnapshot.data()?.generationId === item.generationId
    )
      transaction.delete(activeRef);
  });
}

async function requeueQueueItem(item: QueueItem, retryAfterSeconds = 20) {
  const retrySeconds = boundedInteger(retryAfterSeconds, 20, 1, 300);
  const capacityRetryAt = new Date(
    Date.now() + retrySeconds * 1_000,
  ).toISOString();
  if (localAuth) {
    item.status = "queued";
    item.claimedBy = undefined;
    item.leaseExpiresAt = undefined;
    item.capacityRetryAt = capacityRetryAt;
    return;
  }
  adminApp();
  await getFirestore()
    .collection(generationQueueCollection)
    .doc(item.generationId)
    .set(
      {
        status: "queued",
        claimedBy: null,
        leaseExpiresAt: null,
        capacityRetryAt,
      },
      { merge: true },
    );
}

async function refreshQueueDepth() {
  let oldestQueuedJobAgeSeconds: number;
  if (localAuth) {
    const outstanding = queue.filter(
      (item) => item.status !== "done",
    );
    runtimeState.queueDepth = outstanding.length;
    const oldest = outstanding
      .map((item) => Date.parse(item.createdAt))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    oldestQueuedJobAgeSeconds = oldest
      ? Math.max(0, Math.floor((Date.now() - oldest) / 1_000))
      : 0;
  } else {
    adminApp();
    const firestore = getFirestore();
    const [snapshot, oldestSnapshot] = await Promise.all([
      firestore.collection("runtimeState").doc(queueMetricsDocument).get(),
      firestore
        .collection(generationQueueCollection)
        .where("status", "==", "queued")
        .orderBy("createdAt", "asc")
        .limit(1)
        .get(),
    ]);
    runtimeState.queueDepth = Math.max(
      0,
      Number(snapshot.data()?.outstanding ?? 0),
    );
    const oldest = oldestSnapshot.docs[0]?.data()?.createdAt;
    oldestQueuedJobAgeSeconds =
      typeof oldest === "string" && Number.isFinite(Date.parse(oldest))
        ? Math.max(0, Math.floor((Date.now() - Date.parse(oldest)) / 1_000))
        : 0;
  }
  if (runtime.reportCapacityDemand) {
    await runtime
      .reportCapacityDemand(
        runtimeState.queueDepth,
        oldestQueuedJobAgeSeconds,
      )
      .catch((error) =>
        log("runtime_capacity_report_failed", {
          errorCode: operationalErrorCode(error),
        }),
      );
  }
}
async function principal(req: express.Request): Promise<Principal> {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer "))
    throw problem(401, "unauthenticated", "Missing Firebase bearer token");
  const token = h.slice(7);
  if (localAuth) {
    if (token === "admin-token")
      return { uid: "admin", email: "admin@example.test", admin: true };
    return {
      uid: token.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "demo",
      email: `${token}@example.test`,
      admin: false,
    };
  }
  try {
    adminApp();
    const decoded = await getAuth().verifyIdToken(token);
    const email = decoded.email ?? `${decoded.uid}@firebase.local`;
    return {
      uid: decoded.uid,
      email,
      admin: decoded.admin === true || adminEmails.has(email.toLowerCase()),
    };
  } catch {
    throw problem(
      401,
      "unauthenticated",
      "Invalid or expired Firebase bearer token",
    );
  }
}
function ensureUser(p: Principal) {
  let u = users.get(p.uid);
  if (!u) {
    u = {
      uid: p.uid,
      email: p.email,
      status: "active",
      roles: p.admin ? ["admin"] : [],
      termsVersion: "2026-07",
      trialGrantedAt: nowIso(),
    };
    users.set(p.uid, u);
    wallets.set(p.uid, createWallet(p.uid, 12));
    log("user_initialized", { uid: p.uid });
  }
  return u;
}
async function auth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  try {
    const p = await principal(req);
    ensureUser(p);
    res.locals.principal = p;
    next();
  } catch (e) {
    next(e);
  }
}
async function admin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  try {
    const p = await principal(req);
    ensureUser(p);
    if (!p.admin)
      throw problem(403, "admin_required", "Administrator access required");
    res.locals.principal = p;
    next();
  } catch (e) {
    next(e);
  }
}

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

function enhancementRequest(value: unknown): StoryboardEnhancementRequest {
  const invalid = (code: string, detail: string): never => {
    throw problem(400, code, detail);
  };
  const object = (candidate: unknown, label: string): Record<string, unknown> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      invalid("invalid_storyboard", `${label} must be an object`);
    }
    return candidate as Record<string, unknown>;
  };
  const exact = (candidate: Record<string, unknown>, keys: Set<string>, label: string) => {
    if (Object.keys(candidate).some((key) => !keys.has(key))) {
      invalid("invalid_storyboard", `${label} contains unexpected fields`);
    }
  };
  const string = (candidate: unknown, label: string, maximum: number, allowEmpty = false): string => {
    if (typeof candidate !== "string" || candidate !== candidate.trim() || candidate.length > maximum || (!allowEmpty && !candidate)) {
      invalid("invalid_storyboard", `${label} is invalid`);
    }
    return candidate as string;
  };
  const stringList = (candidate: unknown, label: string, maximumItems: number, maximumLength: number): string[] => {
    if (!Array.isArray(candidate) || candidate.length > maximumItems) invalid("invalid_storyboard", `${label} is invalid`);
    return (candidate as unknown[]).map((item) => string(item, label, maximumLength));
  };
  const source = object(value, "Storyboard enhancement input");
  exact(source, new Set([
    "contractVersion", "projectId", "projectRevision", "operation", "userInstruction", "masterPrompt", "shotCount",
    "generationMode", "continuityBible", "shots", "targetShotNumber", "aspectRatio", "resolution", "references",
    "availableControls", "audioPolicy", "requestedCandidateCount",
    "videoModel",
  ]), "Storyboard enhancement input");
  if (source.contractVersion !== "2") invalid("incompatible_runtime", "Storyboard enhancement contract version 2 is required");
  const operations = new Set(["enhance_master_prompt", "plan_storyboard", "revise_shot", "revise_first_frame", "revise_last_frame"]);
  if (!operations.has(String(source.operation))) invalid("invalid_storyboard", "Storyboard enhancement operation is invalid");
  const operation = source.operation as StoryboardEnhancementRequest["operation"];
  const masterPrompt = string(source.masterPrompt, "Master prompt", 12_000);
  if (masterPrompt.length < 3) invalid("invalid_master_prompt", "Master prompt must be at least 3 characters");
  const shotCount = source.shotCount;
  if (!Number.isInteger(shotCount) || Number(shotCount) < 1 || Number(shotCount) > MAX_STORYBOARD_SCENES) {
    invalid("invalid_shot_count", `Shot count must be 1-${MAX_STORYBOARD_SCENES}`);
  }
  const generationModes = new Set(["text_to_video", "image_to_video", "mixed"]);
  if (!generationModes.has(String(source.generationMode))) invalid("invalid_storyboard", "Generation mode is invalid");
  const rawBible = object(source.continuityBible, "Continuity bible");
  exact(rawBible, new Set(continuityKeys), "Continuity bible");
  const continuityBible = Object.fromEntries(continuityKeys.map((key) => [key, string(rawBible[key], `Continuity ${key}`, 4_000, true)])) as unknown as StoryboardContinuityBible;
  const rawTarget = source.targetShotNumber;
  const targetShotNumber = rawTarget === undefined ? undefined : rawTarget as number;
  if (targetShotNumber !== undefined && (!Number.isInteger(targetShotNumber) || targetShotNumber < 1 || targetShotNumber > Number(shotCount))) {
    invalid("invalid_target_shot", "Target shot is outside the storyboard");
  }
  const targeted = operation.startsWith("revise_");
  if (targeted !== (targetShotNumber !== undefined)) invalid("invalid_target_shot", "The selected operation and target shot do not match");
  if (!Array.isArray(source.shots) || source.shots.length !== Number(shotCount)) invalid("invalid_storyboard", "The shot blueprint must match the selected shot count");
  const rawShots = source.shots as unknown[];
  const allowedControls = new Set(directorControls());
  if (!Array.isArray(source.availableControls) || source.availableControls.length !== 0) {
    invalid("invalid_storyboard", "Available controls are server-owned and must not be supplied by the browser");
  }
  const audioIntentModes = new Set(["silent", "dialogue", "ambience", "sound_effects", "music", "mixed"]);
  const shots = rawShots.map((entry, index) => {
    const shot = object(entry, `Shot ${index + 1}`);
    exact(shot, new Set([
      "shotNumber", "title", "narrativePurpose", "prompt", "firstFramePrompt", "lastFramePrompt", "continuityNotes",
      "durationSeconds", "generationMode", "referenceIds", "selectedControls", "audioIntent", "carryPreviousFrame",
      "firstFrameAvailable", "lastFrameAvailable",
    ]), `Shot ${index + 1}`);
    if (shot.shotNumber !== index + 1) invalid("invalid_storyboard", "Shot numbers must be unique, contiguous and ordered");
    if (!Number.isInteger(shot.durationSeconds) || Number(shot.durationSeconds) < 1 || Number(shot.durationSeconds) > 8) invalid("invalid_storyboard", `Shot ${index + 1} duration is invalid`);
    if (!generationModes.has(String(shot.generationMode))) invalid("invalid_storyboard", `Shot ${index + 1} generation mode is invalid`);
    const selectedControls = stringList(shot.selectedControls, `Shot ${index + 1} controls`, 16, 64);
    if (selectedControls.some((control) => !allowedControls.has(control))) invalid("invalid_storyboard", `Shot ${index + 1} contains an unsupported control`);
    const rawIntent = object(shot.audioIntent, `Shot ${index + 1} audio intent`);
    exact(rawIntent, new Set(["mode", "reason"]), `Shot ${index + 1} audio intent`);
    if (!audioIntentModes.has(String(rawIntent.mode))) invalid("invalid_storyboard", `Shot ${index + 1} audio intent is invalid`);
    if (typeof shot.carryPreviousFrame !== "boolean" || typeof shot.firstFrameAvailable !== "boolean" || typeof shot.lastFrameAvailable !== "boolean") invalid("invalid_storyboard", `Shot ${index + 1} frame state is invalid`);
    return {
      shotNumber: index + 1,
      title: string(shot.title, `Shot ${index + 1} title`, 160, true),
      narrativePurpose: string(shot.narrativePurpose, `Shot ${index + 1} narrative purpose`, 1_000, true),
      prompt: string(shot.prompt, `Shot ${index + 1} prompt`, 12_000, true),
      firstFramePrompt: string(shot.firstFramePrompt, `Shot ${index + 1} first-frame prompt`, 6_000, true),
      lastFramePrompt: string(shot.lastFramePrompt, `Shot ${index + 1} last-frame prompt`, 6_000, true),
      continuityNotes: string(shot.continuityNotes, `Shot ${index + 1} continuity notes`, 2_000, true),
      durationSeconds: shot.durationSeconds as number,
      generationMode: shot.generationMode as StoryboardEnhancementRequest["generationMode"],
      referenceIds: stringList(shot.referenceIds, `Shot ${index + 1} reference ids`, 16, 64),
      selectedControls,
      audioIntent: {
        mode: rawIntent.mode as StoryboardEnhancementRequest["shots"][number]["audioIntent"]["mode"],
        reason: string(rawIntent.reason, `Shot ${index + 1} audio reason`, 1_000, true),
      },
      carryPreviousFrame: shot.carryPreviousFrame as boolean,
      firstFrameAvailable: shot.firstFrameAvailable as boolean,
      lastFrameAvailable: shot.lastFrameAvailable as boolean,
    };
  });
  const projectId = source.projectId === undefined ? undefined : string(source.projectId, "Project id", 64);
  if (projectId && !/^[A-Za-z0-9_-]{8,64}$/.test(projectId)) invalid("invalid_storyboard", "Project id is invalid");
  const projectRevision = source.projectRevision === undefined ? undefined : string(source.projectRevision, "Project revision", 80);
  if (source.userInstruction !== undefined) string(source.userInstruction, "User instruction", 4_000);
  if (!["16:9", "9:16", "1:1"].includes(String(source.aspectRatio))) invalid("invalid_storyboard", "Aspect ratio is invalid");
  const resolution = string(source.resolution, "Resolution", 9);
  if (!/^\d{3,4}x\d{3,4}$/.test(resolution)) invalid("invalid_storyboard", "Resolution is invalid");
  const referenceTypes = new Set(["character", "location", "product", "style", "voice", "motion"]);
  if (!Array.isArray(source.references) || source.references.length > 32) invalid("invalid_reference", "Project references are invalid");
  const rawReferences = source.references as unknown[];
  const seenReferences = new Set<string>();
  const references: StoryboardReferenceSummary[] = rawReferences.map((entry, index) => {
    const reference = object(entry, `Reference ${index + 1}`);
    exact(reference, new Set(["id", "type", "label", "description", "lockedTraits", "version", "shotNumbers"]), `Reference ${index + 1}`);
    const id = string(reference.id, "Reference id", 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || seenReferences.has(id) || !referenceTypes.has(String(reference.type))) invalid("invalid_reference", "Project reference is invalid");
    if (!Number.isInteger(reference.version) || Number(reference.version) < 1) invalid("invalid_reference", "Project reference version is invalid");
    if (!Array.isArray(reference.shotNumbers) || reference.shotNumbers.some((number) => !Number.isInteger(number) || Number(number) < 1 || Number(number) > Number(shotCount))) invalid("invalid_reference", "Project reference scope is invalid");
    seenReferences.add(id);
    return {
      id,
      type: reference.type as StoryboardReferenceSummary["type"],
      label: string(reference.label, "Reference label", 120),
      description: string(reference.description, "Reference description", 2_000, true),
      lockedTraits: stringList(reference.lockedTraits, "Reference locked traits", 24, 240),
      version: reference.version as number,
      shotNumbers: [...new Set(reference.shotNumbers as number[])],
    };
  });
  if (references.length && !projectId) invalid("invalid_reference", "Project references require a valid project");
  const referenceIds = new Set(references.map((reference) => reference.id));
  if (shots.some((shot) => shot.referenceIds.some((id) => !referenceIds.has(id)))) invalid("invalid_reference", "A shot contains an unknown project reference");
  const rawAudioPolicy = object(source.audioPolicy, "Audio policy");
  exact(rawAudioPolicy, new Set(["mode", "dialogue", "soundEffects", "ambience", "music", "preserveSourceAudio"]), "Audio policy");
  if (!["silent", "intent_only", "directed"].includes(String(rawAudioPolicy.mode))
    || !["off", "prompted_only", "on"].includes(String(rawAudioPolicy.dialogue))
    || !["off", "intent_only", "on"].includes(String(rawAudioPolicy.soundEffects))
    || !["off", "intent_only", "on"].includes(String(rawAudioPolicy.ambience))
    || !["off", "prompted_or_unambiguous_performance", "on"].includes(String(rawAudioPolicy.music))
    || typeof rawAudioPolicy.preserveSourceAudio !== "boolean") invalid("invalid_storyboard", "Audio policy is invalid");
  const audioPolicy = rawAudioPolicy as unknown as StoryboardAudioPolicy;
  if (audioPolicy.mode === "silent" && (audioPolicy.dialogue !== "off" || audioPolicy.soundEffects !== "off" || audioPolicy.ambience !== "off" || audioPolicy.music !== "off" || audioPolicy.preserveSourceAudio)) invalid("invalid_storyboard", "Silent audio policy contains enabled audio");
  if (!Number.isInteger(source.requestedCandidateCount) || Number(source.requestedCandidateCount) < 1 || Number(source.requestedCandidateCount) > 4) invalid("invalid_storyboard", "Candidate count is invalid");
  const videoModel = String(source.videoModel ?? "ltx-2.3");
  if (!(longFormVideoModels as readonly string[]).includes(videoModel)) invalid("invalid_video_model", "Video model is not supported");
  return {
    contractVersion: "2",
    projectId,
    projectRevision,
    operation,
    ...(source.userInstruction === undefined ? {} : { userInstruction: source.userInstruction as string }),
    masterPrompt,
    shotCount: shotCount as number,
    generationMode: source.generationMode as StoryboardEnhancementRequest["generationMode"],
    continuityBible,
    shots,
    targetShotNumber,
    aspectRatio: source.aspectRatio as StoryboardEnhancementRequest["aspectRatio"],
    resolution,
    references,
    availableControls: [...allowedControls],
    audioPolicy,
    requestedCandidateCount: source.requestedCandidateCount as number,
    videoModel: videoModel as StoryboardEnhancementRequest["videoModel"],
  };
}

function assemblyRecoveryAttemptLimit(env: NodeJS.ProcessEnv = process.env) {
  return boundedInteger(env.VIDEO_LAB_ASSEMBLY_RECOVERY_ATTEMPTS, 3, 1, 5);
}

const draftKeys = new Set([
  "overallGoal",
  "originalOverallGoal",
  "negativePrompt",
  "resolution",
  "fps",
  "imageSteps",
  "guidanceScale",
  "startFrameStrength",
  "endFrameStrength",
  "enhancePrompt",
  "postProcess",
  "outputFormat",
  "globalVisualAnchorEnabled",
  "globalSeed",
  "seedPolicy",
  "continuityBible",
  "audioPolicy",
  "candidateCount",
  "projectReferences",
  "directorAssumptions",
  "instructionBundle",
  "referencePlanningEvidence",
  "videoModel",
  "scenes",
]);
const draftSceneKeys = new Set([
  "id",
  "title",
  "prompt",
  "duration",
  "trimStart",
  "trimEnd",
  "seed",
  "transition",
  "transitionDuration",
  "carryPreviousFrame",
  "summary",
  "seedOverrideEnabled",
  "continuityOverrides",
  "startFrameGenerationId",
  "endFrameGenerationId",
  "acceptedVideoGenerationId",
  "candidateGenerationIds",
  "candidateVariations",
  "referenceIds",
  "recommendedControls",
  "audioIntent",
  "firstFramePrompt",
  "lastFramePrompt",
  "narrativePurpose",
  "continuityNotes",
  "promptOrigin",
  "staleReason",
  "keyframes",
]);

const MAX_INTERMEDIATE_KEYFRAMES = 6;

function sanitizeDraftTemporalKeyframes(
  value: unknown,
  duration: number,
  sceneNumber: number,
) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INTERMEDIATE_KEYFRAMES) {
    throw problem(
      400,
      "invalid_storyboard_draft",
      `Shot ${sceneNumber} has an invalid intermediate-frame count`,
    );
  }
  let previousTime = 0;
  const identifiers = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw problem(400, "invalid_storyboard_draft", `Shot ${sceneNumber} intermediate frame ${index + 1} is invalid`);
    }
    const source = entry as Record<string, unknown>;
    if (Object.keys(source).some((key) => !["id", "timeSeconds", "strength", "frameAssetId"].includes(key))) {
      throw problem(400, "invalid_storyboard_draft", `Shot ${sceneNumber} intermediate frame ${index + 1} contains unsupported fields`);
    }
    const id = String(source.id ?? "");
    const timeSeconds = Number(source.timeSeconds);
    const strength = Number(source.strength);
    const frameAssetId = String(source.frameAssetId ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || identifiers.has(id)) {
      throw problem(400, "invalid_storyboard_draft", `Shot ${sceneNumber} intermediate frame identifiers must be unique and valid`);
    }
    if (!Number.isFinite(timeSeconds) || timeSeconds <= previousTime || timeSeconds >= duration) {
      throw problem(400, "invalid_storyboard_draft", `Shot ${sceneNumber} intermediate frame times must be ordered inside the scene duration`);
    }
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw problem(400, "invalid_storyboard_draft", `Shot ${sceneNumber} intermediate frame strength is invalid`);
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(frameAssetId)) {
      throw problem(400, "invalid_storyboard_draft", `Shot ${sceneNumber} intermediate frame asset is invalid`);
    }
    identifiers.add(id);
    previousTime = timeSeconds;
    return { id, timeSeconds, strength, frameAssetId };
  });
}

function sanitizeReferencePlanningEvidence(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw problem(400, "invalid_reference_evidence", "Director reference evidence is invalid");
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["visualReferenceAnalyses", "vision", "referenceStates", "instructionBundle", "generatedAt"].includes(key))) {
    throw problem(400, "invalid_reference_evidence", "Director reference evidence contains unsupported fields");
  }
  const requiredText = (entry: unknown, maximum: number) => {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > maximum) {
      throw problem(400, "invalid_reference_evidence", "Director reference evidence contains invalid text");
    }
    return entry;
  };
  if (!Array.isArray(source.visualReferenceAnalyses) || source.visualReferenceAnalyses.length > 6) {
    throw problem(400, "invalid_reference_evidence", "Director visual analyses are invalid");
  }
  const visualReferenceAnalyses = source.visualReferenceAnalyses.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw problem(400, "invalid_reference_evidence", "Director visual analysis is invalid");
    const analysis = entry as Record<string, unknown>;
    if (Object.keys(analysis).some((key) => !["referenceId", "referenceVersion", "observedTraits", "continuityGuidance", "declaredVisibleConflicts"].includes(key))) throw problem(400, "invalid_reference_evidence", "Director visual analysis contains unsupported fields");
    if (!Array.isArray(analysis.observedTraits) || analysis.observedTraits.length > 24 || !Array.isArray(analysis.declaredVisibleConflicts) || analysis.declaredVisibleConflicts.length > 16 || !Number.isInteger(analysis.referenceVersion) || Number(analysis.referenceVersion) < 1 || Number(analysis.referenceVersion) > 1_000) throw problem(400, "invalid_reference_evidence", "Director visual analysis is invalid");
    return {
      referenceId: requiredText(analysis.referenceId, 64),
      referenceVersion: analysis.referenceVersion,
      observedTraits: analysis.observedTraits.map((item) => requiredText(item, 500)),
      continuityGuidance: requiredText(analysis.continuityGuidance, 2_000),
      declaredVisibleConflicts: analysis.declaredVisibleConflicts.map((item) => requiredText(item, 500)),
    };
  });
  const vision = source.vision as Record<string, unknown> | undefined;
  if (!vision || Array.isArray(vision) || Object.keys(vision).some((key) => !["mode", "attachedReferenceIds", "textOnlyReferenceIds"].includes(key)) || vision.mode !== "planning_only" || !Array.isArray(vision.attachedReferenceIds) || vision.attachedReferenceIds.length > 6 || !Array.isArray(vision.textOnlyReferenceIds) || vision.textOnlyReferenceIds.length > 32) throw problem(400, "invalid_reference_evidence", "Director vision accounting is invalid");
  const referenceIds = (entries: unknown[]) => entries.map((item) => requiredText(item, 64));
  const attachedReferenceIds = referenceIds(vision.attachedReferenceIds);
  const textOnlyReferenceIds = referenceIds(vision.textOnlyReferenceIds);
  if (new Set([...attachedReferenceIds, ...textOnlyReferenceIds]).size !== attachedReferenceIds.length + textOnlyReferenceIds.length) throw problem(400, "invalid_reference_evidence", "Director vision accounting contains duplicate references");
  if (!Array.isArray(source.referenceStates) || source.referenceStates.length > 32) throw problem(400, "invalid_reference_evidence", "Director reference states are invalid");
  const referenceStates = source.referenceStates.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw problem(400, "invalid_reference_evidence", "Director reference state is invalid");
    const state = entry as Record<string, unknown>;
    if (Object.keys(state).some((key) => !["referenceId", "version", "shotNumbers"].includes(key)) || !Number.isInteger(state.version) || Number(state.version) < 1 || Number(state.version) > 1_000 || !Array.isArray(state.shotNumbers) || state.shotNumbers.some((shot) => !Number.isInteger(shot) || Number(shot) < 1 || Number(shot) > MAX_STORYBOARD_SCENES)) throw problem(400, "invalid_reference_evidence", "Director reference state is invalid");
    return { referenceId: requiredText(state.referenceId, 64), version: state.version, shotNumbers: [...new Set(state.shotNumbers as number[])] };
  });
  const bundle = source.instructionBundle as Record<string, unknown> | undefined;
  if (!bundle || Array.isArray(bundle) || Object.keys(bundle).some((key) => !["directorVersion", "enhancerVersion", "framePromptVersion", "hash"].includes(key))) throw problem(400, "invalid_reference_evidence", "Director instruction bundle is invalid");
  const hash = requiredText(bundle.hash, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw problem(400, "invalid_reference_evidence", "Director instruction bundle hash is invalid");
  const generatedAt = requiredText(source.generatedAt, 40);
  if (!Number.isFinite(Date.parse(generatedAt))) throw problem(400, "invalid_reference_evidence", "Director evidence timestamp is invalid");
  return {
    visualReferenceAnalyses,
    vision: { mode: "planning_only", attachedReferenceIds, textOnlyReferenceIds },
    referenceStates,
    instructionBundle: {
      directorVersion: requiredText(bundle.directorVersion, 80),
      enhancerVersion: requiredText(bundle.enhancerVersion, 80),
      framePromptVersion: requiredText(bundle.framePromptVersion, 80),
      hash,
    },
    generatedAt,
  };
}

function sanitizeStoryboardDraft(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw problem(
      400,
      "invalid_storyboard_draft",
      "Storyboard draft must be an object",
    );
  }
  const source = value as Record<string, unknown>;
  const draft = Object.fromEntries(
    Object.entries(source).filter(([key]) => draftKeys.has(key)),
  );
  const videoModel = String(draft.videoModel ?? "ltx-2.3");
  if (!(longFormVideoModels as readonly string[]).includes(videoModel)) {
    throw problem(400, "invalid_video_model", "Video model is not supported");
  }
  draft.videoModel = videoModel;
  if (
    typeof draft.overallGoal !== "string" ||
    draft.overallGoal.length > 12_000
  ) {
    throw problem(
      400,
      "invalid_storyboard_draft",
      "Storyboard master prompt is invalid",
    );
  }
  if (
    !Array.isArray(draft.scenes) ||
    draft.scenes.length < 1 ||
    draft.scenes.length > MAX_STORYBOARD_SCENES
  ) {
    throw problem(
      400,
      "invalid_storyboard_draft",
      "Storyboard draft has an invalid shot count",
    );
  }
  draft.scenes = draft.scenes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw problem(
        400,
        "invalid_storyboard_draft",
        `Shot ${index + 1} is invalid`,
      );
    }
    const scene = Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).filter(([key]) =>
        draftSceneKeys.has(key),
      ),
    );
    if (
      typeof scene.id !== "string" ||
      scene.id.length > 200 ||
      typeof scene.prompt !== "string" ||
      scene.prompt.length > 12_000
    ) {
      throw problem(
        400,
        "invalid_storyboard_draft",
        `Shot ${index + 1} is invalid`,
      );
    }
    scene.candidateGenerationIds = Array.isArray(scene.candidateGenerationIds)
      ? [...new Set(scene.candidateGenerationIds
          .map((id) => String(id))
          .filter((id) => /^[A-Za-z0-9_-]{8,64}$/.test(id)))]
          .slice(-24)
      : [];
    scene.candidateVariations = Array.isArray(scene.candidateVariations)
      ? scene.candidateVariations
          .slice(0, 4)
          .map((variation) => String(variation).trim().slice(0, 2_000))
          .filter(Boolean)
      : [];
    scene.referenceIds = Array.isArray(scene.referenceIds)
      ? [...new Set(scene.referenceIds
          .map((id) => String(id))
          .filter((id) => /^[A-Za-z0-9_-]{8,64}$/.test(id)))]
          .slice(0, 32)
      : [];
    scene.recommendedControls = Array.isArray(scene.recommendedControls)
      ? [...new Set(scene.recommendedControls
          .map((control) => String(control))
          .filter((control) => ["start_frame", "end_frame", "multi_keyframe"].includes(control)))]
      : [];
    const sceneDuration = Number(scene.duration);
    if (!Number.isFinite(sceneDuration) || sceneDuration < 1 || sceneDuration > 8) {
      throw problem(400, "invalid_storyboard_draft", `Shot ${index + 1} duration is invalid`);
    }
    scene.keyframes = sanitizeDraftTemporalKeyframes(
      scene.keyframes,
      sceneDuration,
      index + 1,
    );
    return scene;
  });
  draft.candidateCount = Math.min(4, Math.max(1, Math.round(Number(draft.candidateCount) || 3)));
  const audioSource = draft.audioPolicy && typeof draft.audioPolicy === "object" && !Array.isArray(draft.audioPolicy)
    ? draft.audioPolicy as Record<string, unknown>
    : {};
  const audioMode = ["silent", "intent_only", "directed"].includes(String(audioSource.mode)) ? String(audioSource.mode) : "intent_only";
  draft.audioPolicy = {
    mode: audioMode,
    dialogue: ["off", "prompted_only", "on"].includes(String(audioSource.dialogue)) ? audioSource.dialogue : audioMode === "silent" ? "off" : "prompted_only",
    soundEffects: ["off", "intent_only", "on"].includes(String(audioSource.soundEffects)) ? audioSource.soundEffects : audioMode === "silent" ? "off" : "intent_only",
    ambience: ["off", "intent_only", "on"].includes(String(audioSource.ambience)) ? audioSource.ambience : audioMode === "silent" ? "off" : "intent_only",
    music: ["off", "prompted_or_unambiguous_performance", "on"].includes(String(audioSource.music)) ? audioSource.music : audioMode === "silent" ? "off" : "prompted_or_unambiguous_performance",
    preserveSourceAudio: audioMode !== "silent" && audioSource.preserveSourceAudio === true,
  };
  draft.projectReferences = Array.isArray(draft.projectReferences)
    ? draft.projectReferences.slice(0, 32).map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw problem(400, "invalid_reference", "Project reference is invalid");
        const reference = entry as Record<string, unknown>;
        const type = String(reference.type ?? "");
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(reference.id ?? "")) || !["character", "location", "product", "style", "voice", "motion"].includes(type)) {
          throw problem(400, "invalid_reference", "Project reference is invalid");
        }
        const assetId = typeof reference.assetId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(reference.assetId)
          ? reference.assetId
          : undefined;
        const assetVersionIds = Array.isArray(reference.assetVersionIds)
          ? [...new Set(reference.assetVersionIds
              .map((id) => String(id))
              .filter((id) => /^[A-Za-z0-9_-]{8,64}$/.test(id)))]
              .slice(-24)
          : [];
        if (assetId && !assetVersionIds.includes(assetId)) assetVersionIds.push(assetId);
        return {
          id: String(reference.id),
          type,
          label: String(reference.label ?? type).trim().slice(0, 120),
          description: String(reference.description ?? "").trim().slice(0, 2_000),
          lockedTraits: Array.isArray(reference.lockedTraits) ? reference.lockedTraits.slice(0, 24).map((trait) => String(trait).trim().slice(0, 240)).filter(Boolean) : [],
          sceneIds: Array.isArray(reference.sceneIds) ? reference.sceneIds.slice(0, MAX_STORYBOARD_SCENES).map((id) => String(id).slice(0, 200)) : [],
          ...(assetId ? { assetId } : {}),
          assetVersionIds,
          version: Math.min(1000, Math.max(1, Math.round(Number(reference.version) || 1))),
        };
      })
    : [];
  draft.referencePlanningEvidence = sanitizeReferencePlanningEvidence(
    draft.referencePlanningEvidence,
  );
  const encoded = JSON.stringify(draft);
  if (
    Buffer.byteLength(encoded, "utf8") > 512_000 ||
    /data:[^;]+;base64,/i.test(encoded)
  ) {
    throw problem(
      400,
      "invalid_storyboard_draft",
      "Storyboard draft is too large or contains embedded media",
    );
  }
  return draft;
}

function storyboardDraftHasRenderedVideo(form: Record<string, unknown>) {
  const scenes = Array.isArray(form.scenes) ? form.scenes : [];
  return scenes.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const scene = entry as Record<string, unknown>;
    return Boolean(scene.acceptedVideoGenerationId)
      || (Array.isArray(scene.candidateGenerationIds) && scene.candidateGenerationIds.length > 0);
  });
}

async function validateStoryboardReferenceAssets(form: Record<string, unknown>, uid: string) {
  const references = Array.isArray(form.projectReferences)
    ? form.projectReferences as Array<Record<string, unknown>>
    : [];
  for (const reference of references) {
    const assetIds = new Set<string>([
      ...(typeof reference.assetId === "string" ? [reference.assetId] : []),
      ...(Array.isArray(reference.assetVersionIds)
        ? reference.assetVersionIds.map((assetId) => String(assetId))
        : []),
    ]);
    for (const assetId of assetIds) {
      const asset = await findAsset(assetId);
      if (!asset || asset.uid !== uid || !asset.uploadedAt || asset.purpose !== "reference") {
        throw problem(403, "reference_forbidden", "A project reference asset is not owned by the caller");
      }
    }
  }
  const scenes = Array.isArray(form.scenes)
    ? form.scenes as Array<Record<string, unknown>>
    : [];
  for (const scene of scenes) {
    const keyframes = Array.isArray(scene.keyframes)
      ? scene.keyframes as Array<Record<string, unknown>>
      : [];
    for (const keyframe of keyframes) {
      const asset = await findAsset(String(keyframe.frameAssetId ?? ""));
      if (!asset || asset.uid !== uid || !asset.uploadedAt || asset.purpose !== "reference") {
        throw problem(403, "asset_forbidden", "An intermediate-frame asset is not owned by the caller");
      }
    }
  }
}

function canonicalReferenceSummary(
  reference: Record<string, unknown>,
  scenes: Array<Record<string, unknown>>,
): StoryboardReferenceSummary {
  const sceneIds = Array.isArray(reference.sceneIds)
    ? new Set(reference.sceneIds.map(String))
    : new Set<string>();
  return {
    id: String(reference.id),
    type: String(reference.type) as StoryboardReferenceType,
    label: String(reference.label ?? reference.type),
    description: String(reference.description ?? ""),
    lockedTraits: Array.isArray(reference.lockedTraits)
      ? reference.lockedTraits.map(String)
      : [],
    version: Math.min(1_000, Math.max(1, Math.round(Number(reference.version) || 1))),
    shotNumbers: scenes
      .map((scene, index) => (sceneIds.has(String(scene.id)) ? index + 1 : 0))
      .filter((shotNumber) => shotNumber > 0),
  };
}

async function resolveEnhancementRuntimeContext(
  uid: string,
  project: StoredStoryboardProject,
  request: StoryboardEnhancementRequest,
): Promise<{
  request: StoryboardEnhancementRequest;
  runtimeContext: StoryboardEnhancementRuntimeContext;
}> {
  if (request.projectRevision && request.projectRevision !== project.updatedAt) {
    throw problem(
      409,
      "stale_project_revision",
      "The project changed before enhancement started; refresh and try again",
    );
  }
  const rawReferences = Array.isArray(project.form.projectReferences)
    ? (project.form.projectReferences as Array<Record<string, unknown>>)
    : [];
  const scenes = directorSceneRecords(project.form);
  const requestedIds = new Set(request.references.map((reference) => reference.id));
  const canonicalById = new Map(
    rawReferences.map((reference) => [
      String(reference.id),
      {
        raw: reference,
        summary: canonicalReferenceSummary(reference, scenes),
      },
    ]),
  );
  if ([...requestedIds].some((referenceId) => !canonicalById.has(referenceId))) {
    throw problem(403, "reference_forbidden", "A project reference is not owned by this project");
  }
  const references = rawReferences
    .map((reference) => canonicalById.get(String(reference.id)))
    .filter(
      (entry): entry is NonNullable<typeof entry> =>
        Boolean(entry) && requestedIds.has(entry.summary.id),
    );
  const targetNumbers = new Set(
    request.targetShotNumber
      ? [request.targetShotNumber]
      : Array.from({ length: request.shotCount }, (_, index) => index + 1),
  );
  const correlationId = nanoid(20);
  const visualReferences: StoryboardVisualReferenceEnvelope[] = [];
  const textOnlyReferenceIds: string[] = [];
  let totalVisualBytes = 0;

  for (const { raw, summary } of references) {
    const appliesToRequest =
      summary.shotNumbers.length === 0 ||
      summary.shotNumbers.some((shotNumber) => targetNumbers.has(shotNumber));
    const selectedAssetId = typeof raw.assetId === "string" ? raw.assetId : "";
    if (
      !appliesToRequest ||
      summary.type === "voice" ||
      !selectedAssetId ||
      visualReferences.length >= MAX_DIRECTOR_VISUAL_REFERENCES
    ) {
      textOnlyReferenceIds.push(summary.id);
      continue;
    }
    const asset = await findAsset(selectedAssetId);
    if (
      !asset ||
      asset.uid !== uid ||
      !asset.uploadedAt ||
      asset.purpose !== "reference"
    ) {
      throw problem(403, "reference_forbidden", "A project reference asset is not owned by the caller");
    }
    const normalized = await ensureNormalizedReference(asset);
    if (totalVisualBytes + normalized.byteLength > MAX_DIRECTOR_VISUAL_BYTES) {
      textOnlyReferenceIds.push(summary.id);
      continue;
    }
    totalVisualBytes += normalized.byteLength;
    visualReferences.push({
      referenceId: summary.id,
      referenceType: summary.type as Exclude<StoryboardReferenceType, "voice">,
      label: summary.label,
      version: summary.version,
      shotNumbers: summary.shotNumbers,
      mimeType: normalized.contentType,
      base64: normalized.bytes.toString("base64"),
      byteLength: normalized.byteLength,
      sha256: normalized.sha256,
      width: normalized.width,
      height: normalized.height,
      pixelCount: normalized.pixelCount,
    });
  }

  const canonicalRequest: StoryboardEnhancementRequest = {
    ...request,
    projectId: project.id,
    projectRevision: project.updatedAt,
    references: references.map(({ summary }) => summary),
    shots: request.shots.map((shot) => ({
      ...shot,
      referenceIds: shot.referenceIds.filter((referenceId) => requestedIds.has(referenceId)),
    })),
  };
  return {
    request: canonicalRequest,
    runtimeContext: {
      correlationId,
      visualReferences,
      textOnlyReferenceIds: [...new Set(textOnlyReferenceIds)],
    },
  };
}

async function readStoryboardDraft(uid: string) {
  if (localAuth) return storyboardDrafts.get(uid);
  adminApp();
  const snapshot = await getFirestore()
    .collection("storyboardDrafts")
    .doc(uid)
    .get();
  return snapshot.exists
    ? (snapshot.data() as { form: Record<string, unknown>; updatedAt: string })
    : undefined;
}

async function writeStoryboardDraft(
  uid: string,
  form: Record<string, unknown>,
) {
  const draft = { form, updatedAt: nowIso() };
  storyboardDrafts.set(uid, draft);
  if (!localAuth) {
    adminApp();
    await getFirestore()
      .collection("storyboardDrafts")
      .doc(uid)
      .set({ ...draft, uid }, { merge: false });
  }
  return draft;
}

function storyboardProjectKey(uid: string, id: string) {
  return `${uid}:${id}`;
}

function storyboardProjectTitle(value: unknown) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > 120)
    throw problem(
      400,
      "invalid_project_title",
      "Project title must be 1-120 characters",
    );
  return title;
}

function publicStoryboardProject(
  project: StoredStoryboardProject,
): StoryboardProject {
  return {
    id: project.id,
    title: project.title,
    sceneCount: Array.isArray(project.form.scenes)
      ? project.form.scenes.length
      : 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    form: project.form,
  };
}

function publicStoryboardProjectSummary(
  project: StoredStoryboardProject,
): StoryboardProjectSummary {
  const { form: _form, ...summary } = publicStoryboardProject(project);
  return summary;
}

async function findStoryboardProject(uid: string, id: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return undefined;
  const key = storyboardProjectKey(uid, id);
  const cached = storyboardProjects.get(key);
  if (cached || localAuth) return cached;
  adminApp();
  const snapshot = await getFirestore()
    .collection("storyboardProjects")
    .doc(id)
    .get();
  if (!snapshot.exists) return undefined;
  const project = snapshot.data() as StoredStoryboardProject;
  if (project.uid !== uid) return undefined;
  storyboardProjects.set(key, project);
  return project;
}

async function listStoryboardProjects(uid: string) {
  let projects: StoredStoryboardProject[];
  if (localAuth) {
    projects = [...storyboardProjects.values()].filter(
      (project) => project.uid === uid,
    );
  } else {
    adminApp();
    const snapshot = await getFirestore()
      .collection("storyboardProjects")
      .where("uid", "==", uid)
      .limit(100)
      .get();
    projects = snapshot.docs.map(
      (document) => document.data() as StoredStoryboardProject,
    );
    projects.forEach((project) =>
      storyboardProjects.set(storyboardProjectKey(uid, project.id), project),
    );
  }
  return projects
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(publicStoryboardProjectSummary);
}

async function persistStoryboardProject(project: StoredStoryboardProject) {
  storyboardProjects.set(
    storyboardProjectKey(project.uid, project.id),
    project,
  );
  if (!localAuth) {
    adminApp();
    await getFirestore()
      .collection("storyboardProjects")
      .doc(project.id)
      .set(project, { merge: false });
  }
  return publicStoryboardProject(project);
}

async function deleteStoryboardProject(uid: string, id: string) {
  const project = await findStoryboardProject(uid, id);
  if (!project) throw problem(404, "project_not_found", "Project not found");
  storyboardProjects.delete(storyboardProjectKey(uid, id));
  for (const [proposalKey, proposal] of directorProposals.entries()) {
    if (proposal.uid === uid && proposal.projectId === id)
      directorProposals.delete(proposalKey);
  }
  if (localAuth) {
    for (const [generationId, generation] of gens.entries()) {
      if (
        generation.uid === uid &&
        String(generation.settings.projectId ?? "") === id
      )
        gens.delete(generationId);
    }
    return;
  }
  adminApp();
  const firestore = getFirestore();
  const proposalSnapshot = await firestore
    .collection("storyboardDirectorProposals")
    .where("uid", "==", uid)
    .where("projectId", "==", id)
    .get();
  for (let offset = 0; offset < proposalSnapshot.docs.length; offset += 400) {
    const proposalBatch = firestore.batch();
    for (const document of proposalSnapshot.docs.slice(offset, offset + 400))
      proposalBatch.delete(document.ref);
    await proposalBatch.commit();
  }
  const batch = firestore.batch();
  batch.delete(firestore.collection("storyboardProjects").doc(id));
  batch.set(firestore.collection("projectDeletionQueue").doc(id), {
    uid,
    projectId: id,
    status: "queued",
    createdAt: nowIso(),
  });
  await batch.commit();
}

function publicDirectorProposal(proposal: StoredDirectorProposal): DirectorProposal {
  const { uid: _uid, ...visible } = proposal;
  return visible;
}

async function persistDirectorProposal(proposal: StoredDirectorProposal) {
  directorProposals.set(`${proposal.uid}:${proposal.id}`, proposal);
  if (!localAuth) {
    adminApp();
    await getFirestore()
      .collection("storyboardDirectorProposals")
      .doc(proposal.id)
      .set(proposal, { merge: false });
  }
  return publicDirectorProposal(proposal);
}

async function findDirectorProposal(uid: string, id: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return undefined;
  const cached = directorProposals.get(`${uid}:${id}`);
  if (cached || localAuth) return cached;
  adminApp();
  const snapshot = await getFirestore()
    .collection("storyboardDirectorProposals")
    .doc(id)
    .get();
  if (!snapshot.exists) return undefined;
  const proposal = snapshot.data() as StoredDirectorProposal;
  if (proposal.uid !== uid) return undefined;
  directorProposals.set(`${uid}:${id}`, proposal);
  return proposal;
}

async function listDirectorProposals(uid: string, projectId: string) {
  let proposals: StoredDirectorProposal[];
  if (localAuth) {
    proposals = [...directorProposals.values()].filter(
      (proposal) => proposal.uid === uid && proposal.projectId === projectId,
    );
  } else {
    adminApp();
    const snapshot = await getFirestore()
      .collection("storyboardDirectorProposals")
      .where("uid", "==", uid)
      .where("projectId", "==", projectId)
      .limit(50)
      .get();
    proposals = snapshot.docs.map(
      (document) => document.data() as StoredDirectorProposal,
    );
    proposals.forEach((proposal) =>
      directorProposals.set(`${uid}:${proposal.id}`, proposal),
    );
  }
  return proposals
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 50)
    .map(publicDirectorProposal);
}

function directorProposalInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw problem(400, "invalid_director_request", "A Director request is required");
  }
  const source = value as Record<string, unknown>;
  const unexpected = Object.keys(source).filter(
    (key) => !["projectId", "message", "selectedSceneId"].includes(key),
  );
  if (unexpected.length) {
    throw problem(400, "invalid_director_request", "The Director request contains unsupported fields");
  }
  const projectId = typeof source.projectId === "string" ? source.projectId : "";
  const selectedSceneId = typeof source.selectedSceneId === "string" ? source.selectedSceneId : undefined;
  const message = typeof source.message === "string" ? source.message.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(projectId)) {
    throw problem(400, "invalid_project", "A valid project is required");
  }
  if (selectedSceneId && !/^[A-Za-z0-9_-]{1,200}$/.test(selectedSceneId)) {
    throw problem(400, "invalid_scene", "The selected scene is invalid");
  }
  if (message.length < 2 || message.length > 2_000) {
    throw problem(400, "invalid_director_message", "Director messages must be 2-2000 characters");
  }
  return { projectId, selectedSceneId, message };
}

function directorControls() {
  const capabilities = runtimeState.capabilities;
  return [
    capabilities?.startFrame ? "start_frame" : "",
    capabilities?.endFrame ? "end_frame" : "",
    capabilities?.intermediateKeyframes ? "multi_keyframe" : "",
    capabilities?.previousFrameContinuity ? "previous_frame_continuity" : "",
  ].filter(Boolean);
}

function directorSceneRecords(form: Record<string, unknown>) {
  return Array.isArray(form.scenes)
    ? form.scenes.filter(
        (scene): scene is Record<string, unknown> =>
          Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
      )
    : [];
}

function directorReferenceForMessage(form: Record<string, unknown>, message: string) {
  const references = Array.isArray(form.projectReferences)
    ? form.projectReferences.filter(
        (reference): reference is Record<string, unknown> =>
          Boolean(reference) && typeof reference === "object" && !Array.isArray(reference),
      )
    : [];
  const normalizedMessage = message.toLocaleLowerCase();
  return references.find((reference) => {
    const label = String(reference.label ?? "").trim().toLocaleLowerCase();
    return label.length > 0 && (normalizedMessage.includes(`@${label}`) || normalizedMessage.includes(label));
  });
}

function directorDiff(
  action: DirectorProposal["action"],
  form: Record<string, unknown>,
  selectedSceneId: string | undefined,
  payload: Record<string, unknown>,
): DirectorProposalDiff[] {
  const scenes = directorSceneRecords(form);
  const scene = scenes.find((item) => String(item.id) === selectedSceneId) ?? scenes[0];
  const enhancement = payload.enhancement as StoryboardEnhancementResponse | undefined;
  if (action === "set_audio_policy") {
    return [{
      path: "audioPolicy.mode",
      label: "Sound behaviour",
      before: String((form.audioPolicy as Record<string, unknown> | undefined)?.mode ?? "intent_only"),
      after: String(payload.audioMode),
    }];
  }
  if (action === "restore_original_prompt") {
    return [{ path: "overallGoal", label: "Creative brief", before: String(form.overallGoal ?? ""), after: String(form.originalOverallGoal ?? form.overallGoal ?? "") }];
  }
  if (["assign_project_reference", "remove_project_reference"].includes(action)) {
    const referenceId = String(payload.referenceId ?? "");
    const reference = (Array.isArray(form.projectReferences) ? form.projectReferences : [])
      .find((item) => Boolean(item) && typeof item === "object" && String((item as Record<string, unknown>).id) === referenceId) as Record<string, unknown> | undefined;
    const assigned = Array.isArray(scene?.referenceIds) && scene.referenceIds.map(String).includes(referenceId);
    return [{
      path: action === "remove_project_reference" ? `projectReferences.${referenceId}` : `scenes.${String(scene?.id ?? "selected")}.referenceIds`,
      label: String(reference?.label ?? "Project reference"),
      before: action === "remove_project_reference" ? "Available to this project" : assigned ? "Assigned" : "Not assigned",
      after: action === "remove_project_reference" ? "Removed from this project" : "Assigned to this scene",
    }];
  }
  if (action === "enhance_master_prompt" && enhancement) {
    return [{ path: "overallGoal", label: "Creative brief", before: String(form.overallGoal ?? ""), after: enhancement.polishedMasterPrompt }];
  }
  if (action === "plan_storyboard" && enhancement) {
    return [
      { path: "overallGoal", label: "Creative brief", before: String(form.overallGoal ?? ""), after: enhancement.polishedMasterPrompt },
      { path: "scenes", label: "Scene count", before: String(scenes.length), after: String(enhancement.shots.length) },
    ];
  }
  if (action === "propose_scene_change" && enhancement?.shots[0]) {
    const shotNumber = Math.max(1, scenes.findIndex((item) => String(item.id) === String(scene?.id)) + 1);
    const shot = enhancement.shots.find((item) => item.shotNumber === shotNumber);
    return shot ? [{ path: `scenes.${String(scene?.id ?? "selected")}.prompt`, label: `${String(scene?.title ?? "Scene")} prompt`, before: String(scene?.prompt ?? ""), after: shot.prompt }] : [];
  }
  if (action === "propose_frame_prompt_change" && enhancement?.shots[0]) {
    const edge = payload.edge === "end" ? "lastFramePrompt" : "firstFramePrompt";
    const shotNumber = Math.max(1, scenes.findIndex((item) => String(item.id) === String(scene?.id)) + 1);
    const shot = enhancement.shots.find((item) => item.shotNumber === shotNumber);
    return shot ? [{ path: `scenes.${String(scene?.id ?? "selected")}.${edge}`, label: payload.edge === "end" ? "Closing-frame prompt" : "Opening-frame prompt", before: String(scene?.[edge] ?? ""), after: payload.edge === "end" ? shot.lastFramePrompt : shot.firstFramePrompt }] : [];
  }
  return [];
}

async function createDirectorProposal(
  uid: string,
  project: StoredStoryboardProject,
  message: string,
  selectedSceneId?: string,
) {
  const scenes = directorSceneRecords(project.form);
  const selectedScene = scenes.find((scene) => String(scene.id) === selectedSceneId) ?? scenes[0];
  const resolvedSceneId = selectedScene ? String(selectedScene.id) : undefined;
  const intent = classifyDirectorMessage(message);
  const payload: Record<string, unknown> = {
    ...(intent.edge ? { edge: intent.edge } : {}),
    ...(intent.sceneCount ? { sceneCount: intent.sceneCount } : {}),
    ...(intent.candidateNumber ? { candidateNumber: intent.candidateNumber } : {}),
    ...(intent.audioMode ? { audioMode: intent.audioMode } : {}),
    ...(intent.action === "set_audio_policy" && /\b(no music|remove (?:the )?music)\b/i.test(message) ? { music: "off" } : {}),
    ...(resolvedSceneId ? { sceneId: resolvedSceneId } : {}),
    ...(intent.action === "generate_scene_candidates" ? { candidateCount: intent.candidateCount ?? Math.min(4, Math.max(1, Number(project.form.candidateCount) || 3)) } : {}),
  };
  if (["assign_project_reference", "remove_project_reference"].includes(intent.action)) {
    const reference = directorReferenceForMessage(project.form, message);
    if (!reference) {
      throw problem(400, "reference_not_found", "Name an existing project reference, for example @Lead character");
    }
    payload.referenceId = String(reference.id);
  }
  if (["enhance_master_prompt", "plan_storyboard", "propose_scene_change", "propose_frame_prompt_change"].includes(intent.action)) {
    if (!String(project.form.overallGoal ?? "").trim()) {
      throw problem(400, "missing_creative_brief", "Add a creative brief before asking the Director to rewrite it");
    }
    const enhancementRequest = buildDirectorEnhancementRequest(
        project.form,
        message,
        intent,
        resolvedSceneId,
        directorControls(),
        project.id,
      );
    const resolved = await resolveEnhancementRuntimeContext(
      uid,
      project,
      enhancementRequest,
    );
    const enhancement = await enhanceStoryboard(
      resolved.request,
      resolved.runtimeContext,
    );
    payload.enhancement = enhancement;
    payload.referencePlanningEvidence = {
      visualReferenceAnalyses: enhancement.visualReferenceAnalyses,
      vision: enhancement.vision,
      referenceStates: resolved.request.references.map((reference) => ({
        referenceId: reference.id,
        version: reference.version,
        shotNumbers: reference.shotNumbers,
      })),
      instructionBundle: enhancement.instructionBundle,
      generatedAt: nowIso(),
    };
  }
  const copy = proposalCopy(intent, project.form, resolvedSceneId);
  const now = nowIso();
  const invalidations = ["enhance_master_prompt", "plan_storyboard", "propose_scene_change", "propose_frame_prompt_change", "set_audio_policy"].includes(intent.action)
    ? scenes.some((scene) => scene.acceptedVideoGenerationId)
      ? ["Existing accepted clips affected by this change will be marked for review."]
      : []
    : [];
  const affectedSceneIds = intent.action === "remove_project_reference"
    ? scenes
        .filter((scene) => Array.isArray(scene.referenceIds) && scene.referenceIds.map(String).includes(String(payload.referenceId)))
        .map((scene) => String(scene.id))
    : resolvedSceneId && !["enhance_master_prompt", "plan_storyboard", "set_audio_policy", "assemble_project", "export_project"].includes(intent.action)
      ? [resolvedSceneId]
      : [];
  const proposal: StoredDirectorProposal = {
    id: nanoid(16),
    uid,
    projectId: project.id,
    projectRevision: project.updatedAt,
    kind: intent.kind,
    action: intent.action,
    state: "pending",
    summary: copy.summary,
    explanation: copy.explanation,
    confirmationRequired: intent.confirmationRequired,
    executionClass: intent.executionClass,
    affectedSceneIds,
    preserve: resolvedSceneId ? ["Unrelated scenes", "Existing successful media", "Continuity locks"] : ["Existing successful media"],
    invalidations,
    diff: directorDiff(intent.action, project.form, resolvedSceneId, payload),
    payload,
    createdAt: now,
    updatedAt: now,
  };
  return persistDirectorProposal(proposal);
}

async function enhanceStoryboard(
  request: StoryboardEnhancementRequest,
  runtimeContext?: StoryboardEnhancementRuntimeContext,
) {
  const useStableApi = usesIntelligensiRuntimeApi;
  const baseUrl = useStableApi
    ? normalizeRuntimeBaseUrl(process.env.VIDEO_RUNTIME_BASE_URL)
    : normalizeRuntimeOrigin(process.env.VIDEO_DEPLOY_STUDIO_BASE_URL, {
        production: process.env.NODE_ENV === "production",
        allowPrivate: localAuth,
      });
  const token = (
    useStableApi
      ? videoLabRuntimeApiKey()
      : process.env.VIDEO_DEPLOY_STUDIO_API_TOKEN
  )?.trim();
  if (baseUrl && token) {
    try {
      return await new DeployStudioStoryboardEnhancerClient({
        baseUrl,
        token,
        runtimeId: useStableApi
          ? process.env.VIDEO_RUNTIME_ID ??
            "longform-ltx-storyboard-studio"
          : undefined,
        path: useStableApi
          ? process.env.VIDEO_RUNTIME_STORYBOARD_ENHANCE_PATH
          : process.env.VIDEO_DEPLOY_STUDIO_STORYBOARD_ENHANCE_PATH,
        authHeaderName: useStableApi
          ? process.env.VIDEO_RUNTIME_AUTH_HEADER
          : undefined,
        authScheme: useStableApi
          ? process.env.VIDEO_RUNTIME_AUTH_SCHEME
          : undefined,
        timeoutMs: boundedInteger(
          process.env.VIDEO_STORYBOARD_ENHANCER_TIMEOUT_MS,
          250_000,
          30_000,
          10 * 60_000,
        ),
      }).enhance(request, runtimeContext);
    } catch (error) {
      log("storyboard_enhancer_unavailable", {
        provider: useStableApi ? "intelligensi-api" : "deploy-studio",
        reason: error instanceof Error ? error.message : "unknown",
        cause:
          error instanceof Error && error.cause !== undefined
            ? error.cause instanceof Error
              ? error.cause.message
              : String(error.cause)
            : undefined,
        baseUrl,
        shotCount: request.shotCount,
        targeted: request.targetShotNumber !== undefined,
      });
      throw error;
    }
  }
  if (localAuth || process.env.VIDEO_STORYBOARD_ENHANCER_PROVIDER === "mock") {
    return mockStoryboardEnhancement(request, runtimeContext);
  }
  throw problem(
    503,
    "storyboard_enhancer_unavailable",
    "Prompt enhancement is temporarily unavailable; your original prompts are unchanged",
  );
}

export const app: express.Express = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
app.use(securityHeaders);
app.use(cors(corsOptions()));
app.use(
  express.json({
    limit: process.env.VIDEO_LAB_JSON_LIMIT ?? "16mb",
    strict: true,
  }),
);
app.use(
  rateLimit({
    name: "api",
    limit: boundedInteger(
      process.env.VIDEO_LAB_RATE_LIMIT_PER_MINUTE,
      180,
      1,
      10_000,
    ),
  }),
);
app.use((req, _res, next) => {
  if (req.url === "/api" || req.url.startsWith("/api/"))
    req.url = req.url.slice(4) || "/";
  next();
});
if (process.env.NODE_ENV !== "production") {
  const doc = YAML.parse(
    fs.readFileSync(
      new URL("../../../contracts/video-lab.openapi.yaml", import.meta.url),
      "utf8",
    ),
  );
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(doc));
}
app.get("/v1/health", (_req, res) =>
  res.json({ ok: true, service: "video-lab-api", version: "0.1.0" }),
);
app.get("/v1/me", auth, (req, res) =>
  res.json(users.get(res.locals.principal.uid)),
);
app.get("/v1/credits", auth, (req, res) =>
  res.json(wallets.get(res.locals.principal.uid)),
);
app.get("/v1/storyboards/projects", auth, async (_req, res, next) => {
  try {
    res.json({
      items: await listStoryboardProjects(res.locals.principal.uid),
    });
  } catch (error) {
    next(error);
  }
});
app.post("/v1/storyboards/projects", auth, async (req, res, next) => {
  try {
    const createdAt = nowIso();
    const form = sanitizeStoryboardDraft(req.body?.form);
    await validateStoryboardReferenceAssets(form, res.locals.principal.uid);
    const project: StoredStoryboardProject = {
      id: nanoid(),
      uid: res.locals.principal.uid,
      title: storyboardProjectTitle(req.body?.title),
      form,
      createdAt,
      updatedAt: createdAt,
    };
    res.status(201).json(await persistStoryboardProject(project));
  } catch (error) {
    next(error);
  }
});
app.get("/v1/storyboards/projects/:id", auth, async (req, res, next) => {
  try {
    const project = await findStoryboardProject(
      res.locals.principal.uid,
      String(req.params.id ?? ""),
    );
    if (!project) throw problem(404, "project_not_found", "Project not found");
    res.json(publicStoryboardProject(project));
  } catch (error) {
    next(error);
  }
});
app.put("/v1/storyboards/projects/:id", auth, async (req, res, next) => {
  try {
    const uid = res.locals.principal.uid;
    const id = String(req.params.id ?? "");
    const existing = await findStoryboardProject(uid, id);
    if (!existing) throw problem(404, "project_not_found", "Project not found");
    const form = sanitizeStoryboardDraft(req.body?.form);
    await validateStoryboardReferenceAssets(form, uid);
    const existingVideoModel = String(existing.form.videoModel ?? "ltx-2.3");
    const nextVideoModel = String(form.videoModel ?? "ltx-2.3");
    if (
      existingVideoModel !== nextVideoModel
      && (storyboardDraftHasRenderedVideo(existing.form) || storyboardDraftHasRenderedVideo(form))
    ) {
      throw problem(
        409,
        "rendered_project_model_change",
        "Create a separate project copy before changing the video model",
      );
    }
    res.json(
      await persistStoryboardProject({
        ...existing,
        title: storyboardProjectTitle(req.body?.title),
        form,
        updatedAt: nowIso(),
      }),
    );
  } catch (error) {
    next(error);
  }
});
app.delete("/v1/storyboards/projects/:id", auth, async (req, res, next) => {
  try {
    await deleteStoryboardProject(
      res.locals.principal.uid,
      String(req.params.id ?? ""),
    );
    res.status(202).json({ status: "deletion_scheduled" });
  } catch (error) {
    next(error);
  }
});
app.get("/v1/storyboards/draft", auth, async (_req, res, next) => {
  try {
    const draft = await readStoryboardDraft(res.locals.principal.uid);
    res.json(draft ?? { form: null, updatedAt: null });
  } catch (error) {
    next(error);
  }
});
app.put("/v1/storyboards/draft", auth, async (req, res, next) => {
  try {
    const form = sanitizeStoryboardDraft(req.body?.form);
    await validateStoryboardReferenceAssets(form, res.locals.principal.uid);
    res.json(await writeStoryboardDraft(res.locals.principal.uid, form));
  } catch (error) {
    next(error);
  }
});
app.delete("/v1/storyboards/draft", auth, async (_req, res, next) => {
  try {
    const uid = res.locals.principal.uid;
    storyboardDrafts.delete(uid);
    if (!localAuth) {
      adminApp();
      await getFirestore().collection("storyboardDrafts").doc(uid).delete();
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
app.post("/v1/prompts/complete", auth, async (req, res, next) => {
  try {
    await ensureRuntimeConfiguration();
    const prompt = String(req.body?.prompt ?? "").trim();
    const mode = String(req.body?.mode ?? "expand");
    if (prompt.length < 3 || prompt.length > 2400)
      throw problem(400, "invalid_prompt", "Prompt must be 3-2400 characters");
    if (mode !== "expand")
      throw problem(400, "invalid_prompt_mode", "Prompt mode must be expand");
    if (!runtimeBaseUrl && runtimeState.provider !== "mock")
      throw problem(
        503,
        "runtime_unavailable",
        "Connect the Sulphur runtime to develop prompts",
      );
    const result = await runtime.completePrompt(prompt, "expand");
    log("runtime_prompt_completed", {
      uid: res.locals.principal.uid,
      provider: result.provider,
      promptChars: prompt.length,
      resultChars: result.completedPrompt.length,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
app.post(
  "/v1/storyboards/enhance",
  auth,
  rateLimit({ name: "storyboard-enhance", limit: 12 }),
  async (req, res, next) => {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8") > 512 * 1024) {
        throw problem(413, "storyboard_enhancement_request_too_large", "Storyboard enhancement input exceeds the 512 KiB text-only limit");
      }
      let enhancement = enhancementRequest(req.body);
      let runtimeContext: StoryboardEnhancementRuntimeContext | undefined;
      res.setHeader("Cache-Control", "private, no-store");
      if (enhancement.projectId) {
        const project = await findStoryboardProject(
          res.locals.principal.uid,
          String(enhancement.projectId),
        );
        if (!project) throw problem(404, "project_not_found", "Storyboard project not found");
        const resolved = await resolveEnhancementRuntimeContext(
          res.locals.principal.uid,
          project,
          enhancement,
        );
        enhancement = resolved.request;
        runtimeContext = resolved.runtimeContext;
      } else if (enhancement.references.length) {
        throw problem(
          400,
          "project_required",
          "Project references require a saved project",
        );
      }
      const result = await enhanceStoryboard(enhancement, runtimeContext);
      log("storyboard_enhanced", {
        correlationId: runtimeContext?.correlationId ?? nanoid(20),
        shotCount: enhancement.shotCount,
        targeted: enhancement.targetShotNumber !== undefined,
        visualReferenceCount: runtimeContext?.visualReferences.length ?? 0,
      });
      res.json(result);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "storyboard_context_budget_exceeded"
      ) {
        next(
          problem(
            413,
            "storyboard_context_budget_exceeded",
            "This storyboard is too detailed to enhance safely in one request. Reduce the scene detail or enhance one scene at a time; your original prompts are unchanged",
          ),
        );
        return;
      }
      if (
        error instanceof Error &&
        error.message === "storyboard_enhancer_unavailable"
      ) {
        next(
          problem(
            503,
            "storyboard_enhancer_unavailable",
            "Prompt enhancement is temporarily unavailable; your original prompts are unchanged",
          ),
        );
        return;
      }
      if (
        error instanceof Error &&
        [
          "storyboard_enhancement_failed",
          "storyboard_enhancement_request_rejected",
          "storyboard_enhancement_contract_incompatible",
        ].includes(error.message)
      ) {
        next(
          problem(
            502,
            "storyboard_enhancement_failed",
            "Prompt enhancement did not return a valid storyboard; your original prompts are unchanged",
          ),
        );
        return;
      }
      next(error);
    }
  },
);
app.get("/v1/storyboards/director/history", auth, async (req, res, next) => {
  try {
    const projectId = String(req.query.projectId ?? "");
    const project = await findStoryboardProject(res.locals.principal.uid, projectId);
    if (!project) throw problem(404, "project_not_found", "Project not found");
    res.json({ items: await listDirectorProposals(res.locals.principal.uid, projectId) });
  } catch (error) {
    next(error);
  }
});
app.post(
  "/v1/storyboards/director/proposals",
  auth,
  rateLimit({ name: "storyboard-director", limit: 30 }),
  async (req, res, next) => {
    try {
      const input = directorProposalInput(req.body);
      const project = await findStoryboardProject(
        res.locals.principal.uid,
        input.projectId,
      );
      if (!project) throw problem(404, "project_not_found", "Project not found");
      const proposal = await createDirectorProposal(
        res.locals.principal.uid,
        project,
        input.message,
        input.selectedSceneId,
      );
      log("director_proposal_created", {
        uid: res.locals.principal.uid,
        projectId: project.id,
        proposalId: proposal.id,
        action: proposal.action,
        kind: proposal.kind,
      });
      res.status(201).json(proposal);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "storyboard_context_budget_exceeded"
      ) {
        next(
          problem(
            413,
            "storyboard_context_budget_exceeded",
            "This Director request is too detailed to process safely at once. Target one scene or shorten the request; your project is unchanged",
          ),
        );
        return;
      }
      if (
        error instanceof Error &&
        error.message === "storyboard_enhancer_unavailable"
      ) {
        next(
          problem(
            503,
            "storyboard_enhancer_unavailable",
            "The Director is temporarily unavailable; your project is unchanged",
          ),
        );
        return;
      }
      if (
        error instanceof Error &&
        error.message === "storyboard_enhancement_failed"
      ) {
        next(
          problem(
            502,
            "storyboard_enhancement_failed",
            "The Director could not prepare a valid proposal; your project is unchanged",
          ),
        );
        return;
      }
      next(error);
    }
  },
);
app.post(
  "/v1/storyboards/director/proposals/:id/accept",
  auth,
  async (req, res, next) => {
    try {
      if (Object.keys(req.body ?? {}).length) {
        throw problem(400, "invalid_director_request", "Accept does not take a browser-supplied payload");
      }
      const proposal = await findDirectorProposal(
        res.locals.principal.uid,
        String(req.params.id),
      );
      if (!proposal) throw problem(404, "proposal_not_found", "Director proposal not found");
      if (proposal.state !== "pending") {
        throw problem(409, "proposal_resolved", "This Director proposal has already been resolved");
      }
      const project = await findStoryboardProject(
        res.locals.principal.uid,
        proposal.projectId,
      );
      if (!project) throw problem(404, "project_not_found", "Project not found");
      const changesProject = proposal.kind === "draft_change";
      if (changesProject && project.updatedAt !== proposal.projectRevision) {
        throw problem(
          409,
          "project_revision_conflict",
          "The project changed after this proposal was prepared. Ask the Director to review it again.",
        );
      }
      let publicProject: StoryboardProject | undefined;
      if (changesProject) {
        const form = sanitizeStoryboardDraft(
          applyDirectorProposal(project.form, proposal),
        );
        const updatedProject: StoredStoryboardProject = {
          ...project,
          form,
          updatedAt: nowIso(),
        };
        publicProject = await persistStoryboardProject(updatedProject);
      }
      const accepted: StoredDirectorProposal = {
        ...proposal,
        state: "accepted",
        updatedAt: nowIso(),
      };
      const visible = await persistDirectorProposal(accepted);
      log("director_proposal_accepted", {
        uid: res.locals.principal.uid,
        projectId: proposal.projectId,
        proposalId: proposal.id,
        action: proposal.action,
      });
      const result: DirectorProposalResult = {
        proposal: visible,
        ...(publicProject ? { project: publicProject } : {}),
      };
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
app.post(
  "/v1/storyboards/director/proposals/:id/discard",
  auth,
  async (req, res, next) => {
    try {
      if (Object.keys(req.body ?? {}).length) {
        throw problem(400, "invalid_director_request", "Discard does not take a browser-supplied payload");
      }
      const proposal = await findDirectorProposal(
        res.locals.principal.uid,
        String(req.params.id),
      );
      if (!proposal) throw problem(404, "proposal_not_found", "Director proposal not found");
      if (proposal.state !== "pending") {
        throw problem(409, "proposal_resolved", "This Director proposal has already been resolved");
      }
      const discarded = await persistDirectorProposal({
        ...proposal,
        state: "discarded",
        updatedAt: nowIso(),
      });
      log("director_proposal_discarded", {
        uid: res.locals.principal.uid,
        projectId: proposal.projectId,
        proposalId: proposal.id,
        action: proposal.action,
      });
      res.json(discarded);
    } catch (error) {
      next(error);
    }
  },
);
app.post("/v1/assets/upload-url", auth, async (req, res, next) => {
  try {
    const { fileName, contentType, sizeBytes, purpose } = req.body;
    if (
      typeof fileName !== "string" ||
      fileName.trim().length < 1 ||
      fileName.length > 160 ||
      !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > 10485760
    )
      throw problem(400, "invalid_asset", "Unsupported image type or size");
    if (!["start_frame", "end_frame", "reference"].includes(purpose)) {
      throw problem(400, "invalid_asset_purpose", "Unsupported asset purpose");
    }
    const assetId = nanoid();
    const uploadExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const objectPath = `users/${res.locals.principal.uid}/uploads/${assetId}-${String(fileName).replace(/[^\w.-]/g, "_")}`;
    await persistAsset({
      id: assetId,
      uid: res.locals.principal.uid,
      purpose,
      objectPath,
      contentType,
      expectedSize: sizeBytes,
      createdAt: nowIso(),
      uploadExpiresAt,
    });
    res.status(201).json({
      assetId,
      uploadUrl: `/v1/assets/${assetId}/content`,
      method: "PUT",
      expiresAt: uploadExpiresAt,
    });
  } catch (e) {
    next(e);
  }
});
app.put(
  "/v1/assets/:id/content",
  auth,
  express.raw({
    type: ["image/jpeg", "image/png", "image/webp"],
    limit: "10mb",
  }),
  async (req, res, next) => {
    try {
      const asset = await findAsset(String(req.params.id));
      if (!asset || asset.uid !== res.locals.principal.uid) {
        throw problem(
          404,
          "asset_not_found",
          "Asset upload target was not found",
        );
      }
      if (
        new Date(assetUploadExpiresAt(asset)).getTime() <= Date.now() ||
        asset.uploadedAt
      ) {
        throw problem(
          410,
          "asset_upload_expired",
          "Asset upload target has expired or was already used",
        );
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (
        !body.length ||
        body.length !== asset.expectedSize ||
        req.header("content-type") !== asset.contentType ||
        !imageSignatureMatches(body, asset.contentType)
      ) {
        throw problem(
          400,
          "invalid_asset",
          "Uploaded asset does not match the declared type or size",
        );
      }
      let normalized: Awaited<ReturnType<typeof normalizeVisualReference>>;
      try {
        normalized = await normalizeVisualReference(
          body,
          asset.contentType as SupportedReferenceContentType,
        );
      } catch (error) {
        const animated =
          error instanceof Error && error.message === "reference_image_animated";
        throw problem(
          400,
          animated ? "animated_asset_unsupported" : "invalid_asset",
          animated
            ? "Animated images are not supported for storyboard frames or references"
            : "Uploaded asset is not a valid supported still image",
        );
      }
      asset.uploadedAt = nowIso();
      asset.sourceSha256 = normalized.sourceSha256;
      asset.sourceWidth = normalized.sourceWidth;
      asset.sourceHeight = normalized.sourceHeight;
      asset.sourcePixelCount = normalized.sourcePixelCount;
      if (localAuth) {
        asset.bytes = body;
      }
      else {
        adminApp();
        await getStorage().bucket().file(asset.objectPath).save(body, {
            resumable: false,
            contentType: asset.contentType,
            metadata: { cacheControl: "private,no-store" },
          });
      }
      await persistAsset(asset);
      log("asset_uploaded", {
        correlationId: nanoid(20),
        purpose: asset.purpose,
        sizeBytes: body.length,
        normalizedSizeBytes: normalized.byteLength,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);
app.get("/v1/assets/:id/content", auth, async (req, res, next) => {
  try {
    const asset = await findAsset(String(req.params.id));
    if (!asset || asset.uid !== res.locals.principal.uid || !asset.uploadedAt) {
      throw problem(404, "asset_not_found", "Private reference was not found");
    }
    const bytes = await readStoredAssetBytes(asset);
    res.set({
      "Content-Type": asset.contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${asset.id}"`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});
app.post(
  "/v1/generations",
  auth,
  rateLimit({ name: "generation-submit", limit: 10 }),
  async (req, res, next) => {
    try {
      await ensureRuntimeConfiguration();
      if (
        !runtimeState.acceptingSubmissions &&
        runtimeState.status === "unavailable" &&
        !runtimeState.killSwitch
      )
        await refreshRuntimeHealth();
      const p = res.locals.principal as Principal;
      const key = req.header("idempotency-key");
      if (!key || !/^[A-Za-z0-9:_-]{8,128}$/.test(key))
        throw problem(
          400,
          "idempotency_key_required",
          "Idempotency-Key header is required",
        );
      const existing = await findIdempotentGeneration(p.uid, key);
      if (existing) {
        log("generation_idempotent_replay", {
          uid: p.uid,
          generationId: existing.id,
        });
        return res.json(publicGeneration(existing));
      }
      if (
        !runtimeState.acceptingSubmissions ||
        runtimeState.killSwitch ||
        (!runtimeBaseUrl && runtimeState.provider !== "mock")
      )
        throw problem(503, "runtime_paused", "Submissions are paused");
      await reconcileActiveGeneration(p.uid);
      if (localAuth) {
        const active = [...gens.values()].find(
          (g) => g.uid === p.uid && activeGenerationStatus(g.status),
        );
        if (active)
          throw problem(
            409,
            "active_generation_exists",
            "Only one active generation is allowed",
          );
      }
      const {
        prompt,
        settings: requestedSettings,
        inputAssets = [],
      } = req.body;
      if (
        typeof prompt !== "string" ||
        prompt.trim().length < 8 ||
        prompt.length > 12_000
      )
        throw problem(
          400,
          "invalid_prompt",
          "Prompt must be 8-12000 characters",
        );
      if (
        !requestedSettings ||
        typeof requestedSettings !== "object" ||
        Array.isArray(requestedSettings)
      ) {
        throw problem(
          400,
          "invalid_settings",
          "Generation settings are required",
        );
      }
      const settings = (await resolveAssetIds(
        requestedSettings,
        p.uid,
      )) as Generation["settings"];
      const requestedVideoModel = String(settings.videoModel ?? "ltx-2.3");
      if (!(longFormVideoModels as readonly string[]).includes(requestedVideoModel)) {
        throw problem(400, "invalid_video_model", "Video model is not supported");
      }
      const advertisedVideoModels = runtimeState.capabilities?.videoModels;
      const advertisedVideoModel = advertisedVideoModels?.find(
        (model) => model.id === requestedVideoModel,
      );
      const requiresExplicitCapability = requestedVideoModel !== "ltx-2.3";
      if (
        (requiresExplicitCapability && !advertisedVideoModels?.length)
        || (advertisedVideoModels?.length && !advertisedVideoModel?.available)
      ) {
        throw problem(
          409,
          "video_model_unavailable",
          "The selected video model is not available on the active managed runtime",
        );
      }
      settings.videoModel = requestedVideoModel;
      if (!Array.isArray(inputAssets) || inputAssets.length > 3) {
        throw problem(
          400,
          "invalid_assets",
          "At most three input assets are supported",
        );
      }
      validateAssetReferences(settings, p.uid);
      const operationScope = (settings as { operationScope?: unknown })
        .operationScope;
      if (
        operationScope !== undefined &&
        !["project", "scene", "start_frame", "end_frame", "assembly"].includes(
          String(operationScope),
        )
      ) {
        throw problem(
          400,
          "invalid_operation_scope",
          "Unsupported storyboard operation",
        );
      }
      const storyboard = (settings as { storyboard?: unknown })?.storyboard;
      if (
        Array.isArray(storyboard) &&
        storyboard.length > MAX_STORYBOARD_SCENES
      )
        throw problem(
          400,
          "scene_limit_exceeded",
          `Storyboard supports up to ${MAX_STORYBOARD_SCENES} scenes per generation`,
        );
      if (Array.isArray(storyboard)) {
        if (storyboard.length < 1)
          throw problem(
            400,
            "invalid_storyboard",
            "Storyboard requires at least one scene",
          );
        const sceneIds = new Set<string>();
        storyboard.forEach((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw problem(
              400,
              "invalid_storyboard",
              `Scene ${index + 1} is invalid`,
            );
          const scene = entry as Record<string, unknown>;
          const sceneId = String(scene.id ?? "");
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(sceneId) || sceneIds.has(sceneId))
            throw problem(
              400,
              "invalid_storyboard",
              "Scene identifiers must be unique and valid",
            );
          sceneIds.add(sceneId);
          const duration = Number(scene.duration);
          const durationRequired = ["project", "scene", "assembly"].includes(
            String(operationScope),
          );
          const durationProvided =
            scene.duration !== undefined && scene.duration !== null;
          if (
            (durationRequired && !Number.isFinite(duration)) ||
            (durationProvided &&
              (!Number.isFinite(duration) || duration < 1 || duration > 8))
          )
            throw problem(
              400,
              "invalid_scene_duration",
              "Scene duration must be 1-8 seconds",
            );
          if (Number.isFinite(duration)) {
            const trimStart = Number(scene.trimStart ?? 0);
            const trimEnd = Number(scene.trimEnd ?? duration);
            if (
              !Number.isFinite(trimStart) ||
              !Number.isFinite(trimEnd) ||
              trimStart < 0 ||
              trimEnd > duration ||
              trimEnd - trimStart < 0.25
            )
              throw problem(
                400,
                "invalid_scene_trim",
                "Scene trim must preserve at least 0.25 seconds",
              );
          }
          if (
            Array.isArray(scene.keyframes) &&
            scene.keyframes.length > 0 &&
            !["project", "scene"].includes(String(operationScope))
          ) {
            throw problem(
              400,
              "invalid_temporal_keyframes",
              "Intermediate frame anchors are supported only for scene rendering",
            );
          }
          validateRuntimeTemporalKeyframes(
            scene.keyframes,
            duration,
            index + 1,
            p.uid,
          );
        });
      }
      const projectId = String(
        (settings as { projectId?: unknown }).projectId ?? "",
      );
      let project: StoredStoryboardProject | undefined;
      if (projectId) {
        project = await findStoryboardProject(p.uid, projectId);
        if (!project)
          throw problem(404, "project_not_found", "Project not found");
        const projectVideoModel = String(project.form.videoModel ?? "ltx-2.3");
        if (!(longFormVideoModels as readonly string[]).includes(projectVideoModel)) {
          throw problem(409, "project_video_model_invalid", "The project video model is not supported");
        }
        if (projectVideoModel !== requestedVideoModel) {
          throw problem(
            409,
            "project_video_model_mismatch",
            "The generation model must match the project video model",
          );
        }
      }
      const referenceSnapshot = await captureGenerationReferenceSnapshot(
        settings,
        project,
        p.uid,
      );
      if (
        Object.prototype.hasOwnProperty.call(settings, "assemblyJobIds") ||
        Object.prototype.hasOwnProperty.call(settings, "assemblySources")
      )
        throw problem(
          400,
          "invalid_assembly_sources",
          "Private runtime job identifiers cannot be supplied by clients",
        );
      if (operationScope === "start_frame" || operationScope === "end_frame") {
        if (!Array.isArray(storyboard) || storyboard.length !== 1) {
          throw problem(
            400,
            "invalid_frame_job",
            "Frame generation requires exactly one selected shot",
          );
        }
        const sceneId = (storyboard[0] as { id?: unknown })?.id;
        if (
          !sceneId ||
          sceneId !==
            (settings as { operationSceneId?: unknown }).operationSceneId
        ) {
          throw problem(
            400,
            "invalid_frame_job",
            "Frame generation shot identifier is invalid",
          );
        }
        const framePrompt = (settings as { framePrompt?: unknown }).framePrompt;
        if (
          typeof framePrompt !== "string" ||
          framePrompt.trim().length < 8 ||
          framePrompt.length > 6_000
        ) {
          throw problem(
            400,
            "invalid_frame_prompt",
            "Frame prompt must be 8-6000 characters",
          );
        }
      }
      if (operationScope === "scene") {
        const operationSceneId = String(
          (settings as { operationSceneId?: unknown }).operationSceneId ?? "",
        );
        if (
          !Array.isArray(storyboard) ||
          !storyboard.some(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              String((entry as { id?: unknown }).id ?? "") === operationSceneId,
          )
        )
          throw problem(
            400,
            "invalid_scene_job",
            "Scene generation requires a selected storyboard scene",
          );
      }
      if (operationScope === "assembly") {
        const acceptedIds = (
          settings as { acceptedSceneGenerationIds?: unknown }
        ).acceptedSceneGenerationIds;
        if (
          !Array.isArray(storyboard) ||
          !Array.isArray(acceptedIds) ||
          acceptedIds.length !== storyboard.length
        )
          throw problem(
            400,
            "invalid_assembly_sources",
            "Assembly requires one accepted clip for every scene",
          );
        for (let index = 0; index < acceptedIds.length; index += 1) {
          const accepted = await findGeneration(
            String(acceptedIds[index] ?? ""),
          );
          const expectedSceneId = String(
            (storyboard[index] as { id?: unknown } | undefined)?.id ?? "",
          );
          if (
            !accepted ||
            accepted.uid !== p.uid ||
            accepted.status !== "completed" ||
            accepted.settings.operationScope !== "scene" ||
            accepted.settings.operationSceneId !== expectedSceneId ||
            accepted.settings.projectId !== projectId ||
            String(accepted.settings.videoModel ?? "ltx-2.3") !== requestedVideoModel
          )
            throw problem(
              400,
              "invalid_assembly_sources",
              "An accepted scene clip is missing, stale or not owned by you",
            );
        }
      }
      const globalQueueLimit = boundedInteger(
        process.env.VIDEO_RUNTIME_GLOBAL_QUEUE_LIMIT,
        100,
        1,
        10_000,
      );
      for (const a of inputAssets) {
        if ((await findAsset(String(a.assetId ?? "")))?.uid !== p.uid)
          throw problem(403, "asset_forbidden", "Asset is not owned by caller");
      }
      const cost = 0;
      log("generation_credit_free", { uid: p.uid });
      const id = nanoid();
      const gen: StoredGeneration = {
        id,
        uid: p.uid,
        prompt,
        settings,
        ...(referenceSnapshot.length > 0 ? { referenceSnapshot } : {}),
        inputAssets,
        status: "queued" as const,
        creditCost: cost,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        queuePosition: queue.length + 1,
      };
      const queued = await enqueueGeneration(gen, key, globalQueueLimit);
      if (!queued.created) {
        log("generation_idempotent_replay", {
          uid: p.uid,
          generationId: queued.generation.id,
        });
        return res.json(publicGeneration(queued.generation));
      }
      runtimeState = {
        ...runtimeState,
        queueDepth: Math.max(1, runtimeState.queueDepth),
        updatedAt: nowIso(),
      };
      log("generation_submitted", { uid: p.uid, generationId: id });
      res.status(201).json(publicGeneration(gen));
      void refreshQueueDepth().catch((error) =>
        log("runtime_capacity_refresh_failed", {
          errorCode: operationalErrorCode(error),
        }),
      );
      if (
        process.env.NODE_ENV !== "test" &&
        process.env.NODE_ENV !== "production" &&
        !process.env.FUNCTION_TARGET &&
        !process.env.K_SERVICE
      )
        void processOne("local-auto-worker");
    } catch (e) {
      next(e);
    }
  },
);
app.get("/v1/generations/:id", auth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const g = await findGeneration(id);
    if (!g || g.uid !== res.locals.principal.uid)
      throw problem(404, "not_found", "Generation not found");
    res.json(publicGeneration(g));
  } catch (e) {
    next(e);
  }
});
app.get("/v1/generations/:id/download", auth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const g = await findGeneration(id);
    if (!g || g.uid !== res.locals.principal.uid)
      throw problem(404, "not_found", "Generation not found");
    const extension =
      g.outputContentType === "image/png"
        ? "png"
        : g.outputContentType === "image/jpeg"
          ? "jpg"
          : g.outputContentType === "image/webp"
            ? "webp"
            : g.outputContentType === "video/webm"
              ? "webm"
              : "mp4";
    res
      .type(g.outputContentType ?? "video/mp4")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${g.id}.${extension}"`,
      )
      .setHeader("Cache-Control", "private,no-store");
    if (g.outputBytes) return res.send(Buffer.from(g.outputBytes));
    if (!g.outputObjectPath)
      throw problem(
        404,
        "output_not_available",
        "Generation output is not available for download",
      );
    adminApp();
    const file = getStorage().bucket().file(g.outputObjectPath);
    const [exists] = await file.exists();
    if (!exists)
      throw problem(
        404,
        "output_not_available",
        "Generation output is not available for download",
      );
    file.createReadStream().on("error", next).pipe(res);
  } catch (e) {
    next(e);
  }
});
app.post("/v1/generations/:id/edits", auth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const g = await findGeneration(id);
    if (!g || g.uid !== res.locals.principal.uid)
      throw problem(404, "not_found", "Generation not found");
    if (g.status !== "completed" || g.output?.kind !== "video")
      throw problem(409, "generation_not_editable", "Only completed videos can be trimmed");
    if (g.outputContentType && g.outputContentType !== "video/mp4")
      throw problem(400, "unsupported_output", "Only MP4 generation outputs can be trimmed");

    const startSeconds = parseTrimSeconds(req.body?.startSeconds, "startSeconds");
    const endSeconds = parseTrimSeconds(req.body?.endSeconds, "endSeconds");
    const sourceDuration = Number(g.output?.durationSeconds ?? g.settings.durationSeconds ?? 0);
    if (endSeconds <= startSeconds + 0.05)
      throw problem(400, "invalid_trim", "Trim end must be after trim start");
    if (Number.isFinite(sourceDuration) && sourceDuration > 0 && endSeconds > sourceDuration + 0.25)
      throw problem(400, "invalid_trim", "Trim end is outside the source video duration");

    const editId = nanoid();
    const createdAt = nowIso();
    let edit: StoredGenerationEdit = {
      id: editId,
      uid: g.uid,
      generationId: g.id,
      startSeconds,
      endSeconds,
      status: "processing",
      createdAt,
      updatedAt: createdAt,
    };
    await persistGenerationEdit(edit);

    try {
      const sourceBytes = await readGenerationOutputBytes(g);
      const outputBytes = await createTrimmedMp4(sourceBytes, startSeconds, endSeconds);
      const outputSha256 = createHash("sha256").update(outputBytes).digest("hex");
      const outputObjectPath = `users/${g.uid}/edits/${editId}.mp4`;
      if (!localAuth) {
        adminApp();
        await getStorage().bucket().file(outputObjectPath).save(outputBytes, {
          resumable: false,
          contentType: "video/mp4",
          metadata: {
            cacheControl: "private,no-store",
            metadata: {
              sha256: outputSha256,
              sourceGenerationId: g.id,
              trimStartSeconds: String(startSeconds),
              trimEndSeconds: String(endSeconds),
            },
          },
        });
      }
      edit = {
        ...edit,
        status: "completed",
        output: {
          downloadUrl: `/api/v1/generations/${g.id}/edits/${editId}/download`,
          durationSeconds: endSeconds - startSeconds,
          contentType: "video/mp4",
          kind: "video",
        },
        ...(localAuth ? { outputBytes } : {}),
        outputObjectPath,
        outputSha256,
        updatedAt: nowIso(),
      };
      await persistGenerationEdit(edit);
      log("generation_edit_completed", {
        uid: g.uid,
        generationId: g.id,
        editId,
        startSeconds,
        endSeconds,
      });
      res.status(201).json(publicGenerationEdit(edit));
    } catch (error) {
      edit = {
        ...edit,
        status: "failed",
        safeErrorMessage:
          error instanceof Error ? error.message : "The video could not be trimmed.",
        updatedAt: nowIso(),
      };
      await persistGenerationEdit(edit);
      throw error;
    }
  } catch (e) {
    next(e);
  }
});
app.get("/v1/generations/:id/edits/:editId", auth, async (req, res, next) => {
  try {
    const generationId = String(req.params.id ?? "");
    const editId = String(req.params.editId ?? "");
    const edit = await findGenerationEdit(editId);
    if (
      !edit ||
      edit.generationId !== generationId ||
      edit.uid !== res.locals.principal.uid
    )
      throw problem(404, "not_found", "Generation edit not found");
    res.json(publicGenerationEdit(edit));
  } catch (e) {
    next(e);
  }
});
app.get("/v1/generations/:id/edits/:editId/download", auth, async (req, res, next) => {
  try {
    const generationId = String(req.params.id ?? "");
    const editId = String(req.params.editId ?? "");
    const edit = await findGenerationEdit(editId);
    if (
      !edit ||
      edit.generationId !== generationId ||
      edit.uid !== res.locals.principal.uid ||
      edit.status !== "completed"
    )
      throw problem(404, "not_found", "Generation edit not found");
    res
      .type("video/mp4")
      .setHeader("Content-Disposition", `attachment; filename="${edit.id}.mp4"`)
      .setHeader("Cache-Control", "private,no-store");
    if (edit.outputBytes) return res.send(Buffer.from(edit.outputBytes));
    if (!edit.outputObjectPath)
      throw problem(404, "output_not_available", "Edited video is not available for download");
    adminApp();
    const file = getStorage().bucket().file(edit.outputObjectPath);
    const [exists] = await file.exists();
    if (!exists)
      throw problem(404, "output_not_available", "Edited video is not available for download");
    file.createReadStream().on("error", next).pipe(res);
  } catch (e) {
    next(e);
  }
});
app.post("/v1/generations/:id/cancel", auth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const g = await findGeneration(id);
    if (!g || g.uid !== res.locals.principal.uid)
      throw problem(404, "not_found", "Generation not found");
    if (["completed", "failed", "cancelled"].includes(g.status))
      return res.json(publicGeneration(g));
    const cancellation = await requireRuntimeCancellation(g, "cancel");
    if (cancellation === "accepted") {
      const cancelling: StoredGeneration = {
        ...g,
        runtimeMessage: "Cancellation requested. Waiting for the generator to stop safely.",
        updatedAt: nowIso(),
      };
      gens.set(g.id, cancelling);
      await persistGeneration(cancelling);
      return res.status(202).json(publicGeneration(cancelling));
    }
    const wallet = wallets.get(g.uid);
    if (creditLimitsEnabled() && wallet && wallet.reserved >= g.creditCost)
      wallets.set(g.uid, releaseCredits(wallet, g.creditCost));
    const ng: StoredGeneration = {
      ...g,
      status: "cancelled" as const,
      updatedAt: nowIso(),
      safeErrorMessage: "Cancelled by user",
    };
    gens.set(g.id, ng);
    await persistGeneration(ng);
    const q = queue.find((i) => i.generationId === g.id) ?? {
      generationId: g.id,
      createdAt: g.createdAt,
      status: "claimed" as const,
      attempt: 0,
    };
    await finishQueueItem(q, g.uid);
    await refreshQueueDepth();
    log("generation_cancelled", { uid: g.uid, generationId: g.id });
    res.json(publicGeneration(ng));
  } catch (e) {
    next(e);
  }
});
app.delete("/v1/generations/:id", auth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const g = await findGeneration(id);
    if (!g || g.uid !== res.locals.principal.uid)
      throw problem(404, "not_found", "Generation not found");
    if (activeGenerationStatus(g.status)) {
      const cancellation = await requireRuntimeCancellation(g, "delete");
      if (cancellation === "accepted") {
        throw problem(
          409,
          "runtime_cancel_pending",
          "Deletion is waiting for the active generation to stop safely. Retry after cancellation completes.",
        );
      }
    }
    await deleteStoredGeneration(g);
    await refreshQueueDepth();
    log("generation_deleted", { uid: g.uid, generationId: g.id });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});
app.get("/v1/gallery", auth, async (req, res, next) => {
  try {
    const p = res.locals.principal as Principal;
    const requestedLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50)
      throw problem(400, "invalid_gallery_query", "Gallery limit must be an integer from 1 to 50");
    const status = req.query.status;
    if (
      status !== undefined &&
      (typeof status !== "string" ||
        !["queued", "preparing", "generating", "uploading", "completed", "failed", "cancelled"].includes(status))
    )
      throw problem(400, "invalid_gallery_query", "Gallery status is invalid");
    if (!localAuth) {
      adminApp();
      let query = getFirestore()
        .collection("generations")
        .where("uid", "==", p.uid)
        .orderBy("createdAt", "desc")
        .limit(requestedLimit);
      const snapshot = await query.get();
      const items = snapshot.docs
        .map((doc) => doc.data() as StoredGeneration)
        .filter(
          (g) =>
            (!status || g.status === status) &&
            !["start_frame", "end_frame"].includes(
              String(g.settings.operationScope ?? ""),
            ),
        )
        .map(publicGeneration);
      return res.json({ items });
    }
    const items = [...gens.values()]
      .filter(
        (g) =>
          g.uid === p.uid &&
          (!status || g.status === status) &&
          !["start_frame", "end_frame"].includes(
            String(g.settings.operationScope ?? ""),
          ),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, requestedLimit)
      .map(publicGeneration);
    res.json({ items });
  } catch (e) {
    next(e);
  }
});
app.get("/v1/runtime/status", auth, async (_req, res, next) => {
  try {
    await ensureRuntimeConfiguration();
    await refreshRuntimeHealth();
    await refreshQueueDepth();
    res.json(publicRuntimeStatus());
  } catch (e) {
    next(e);
  }
});
app.post("/v1/admin/runtime/discover", admin, async (_req, res, next) => {
  try {
    runtimeDiscoveryCheckedAt = 0;
    await loadRuntimeDiscovery(true);
    await refreshRuntimeHealth();
    log("admin_runtime_discovery_refreshed", {
      source: runtimeDiscovery.source,
      state: runtimeDiscovery.state,
    });
    await recordAdminAudit(res.locals.principal, "runtime_discovery_refreshed");
    res.json(publicRuntimeStatus());
  } catch (e) {
    next(e);
  }
});
app.post("/v1/admin/runtime/connect", admin, async (req, res, next) => {
  try {
    const baseUrl = normalizeRuntimeBaseUrl(req.body?.baseUrl);
    if (!baseUrl)
      throw problem(
        400,
        "invalid_runtime_origin",
        "Enter a valid HTTP or HTTPS runtime origin",
      );
    await connectRuntimeEndpoint(
      baseUrl,
      "environment",
      "Manual admin connection is active until Deploy Studio publishes a healthy handover",
    );
    manualRuntimeBaseUrl = baseUrl;
    await persistRuntimeControl(
      res.locals.principal,
      "runtime_manual_connected",
    );
    res.json(publicRuntimeStatus());
  } catch (e) {
    next(e);
  }
});
app.post("/v1/admin/runtime/pause", admin, async (_req, res, next) => {
  try {
    runtimeState = {
      ...runtimeState,
      acceptingSubmissions: false,
      status: "paused",
      updatedAt: nowIso(),
    };
    manualRuntimeBaseUrl = undefined;
    await persistRuntimeControl(res.locals.principal, "runtime_pause");
    res.json(publicRuntimeStatus());
  } catch (error) {
    next(error);
  }
});
app.post("/v1/admin/runtime/resume", admin, async (_req, res, next) => {
  try {
    runtimeState = {
      ...runtimeState,
      acceptingSubmissions: true,
      killSwitch: false,
      status: "healthy",
      updatedAt: nowIso(),
    };
    await persistRuntimeControl(res.locals.principal, "runtime_resume");
    res.json(publicRuntimeStatus());
  } catch (error) {
    next(error);
  }
});
app.post("/v1/admin/runtime/stop", admin, async (_req, res, next) => {
  try {
    runtimeState = {
      ...runtimeState,
      acceptingSubmissions: false,
      killSwitch: true,
      status: "unavailable",
      updatedAt: nowIso(),
    };
    manualRuntimeBaseUrl = undefined;
    await persistRuntimeControl(res.locals.principal, "runtime_stop");
    res.json(publicRuntimeStatus());
  } catch (error) {
    next(error);
  }
});
app.post("/v1/admin/credits/adjust", admin, async (req, res, next) => {
  const uid = typeof req.body?.uid === "string" ? req.body.uid.trim() : "";
  const amount = Number(req.body?.amount);
  const reason =
    typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (
    !uid ||
    !Number.isInteger(amount) ||
    Math.abs(amount) > 100_000 ||
    reason.length < 3
  ) {
    res
      .status(400)
      .json(
        problem(
          400,
          "invalid_credit_adjustment",
          "A user, integer amount and reason are required",
          res.locals.requestId,
        ),
      );
    return;
  }
  const w = wallets.get(uid) ?? createWallet(uid, 0);
  const nw = {
    ...w,
    available: w.available + amount,
    updatedAt: nowIso(),
    version: w.version + 1,
  };
  wallets.set(uid, nw);
  log("admin_credit_adjustment", {
    uid,
    amount,
    reason,
  });
  try {
    await recordAdminAudit(res.locals.principal, "credit_adjustment_recorded");
    res.json(nw);
  } catch (error) {
    next(error);
  }
});
async function processQueueItem(workerId = "local-worker") {
  await ensureRuntimeConfiguration();
  const item = await claimQueueItem(workerId);
  if (!item) return false;
  const g = await findGeneration(item.generationId);
  if (!g || g.status === "cancelled") {
    await finishQueueItem(item, g?.uid);
    await refreshQueueDepth();
    return true;
  }
  let finishClaim = true;
  try {
    const assemblyRuntimeAttempt =
      g.settings.operationScope === "assembly"
        ? Math.max(1, g.assemblyRuntimeAttempt ?? 1)
        : undefined;
    const preparing = {
      ...g,
      ...(assemblyRuntimeAttempt ? { assemblyRuntimeAttempt } : {}),
      status: "preparing" as const,
      queuePosition: 0,
      updatedAt: nowIso(),
    };
    gens.set(g.id, preparing);
    await persistGeneration(preparing);
    const runtimeInput = await runtimeGeneration(preparing);
    log("generation_runtime_payload_shape", {
      generationId: g.id,
      operationScope: (runtimeInput.settings as { operationScope?: unknown })
        .operationScope,
      videoModel: (runtimeInput.settings as { videoModel?: unknown })
        .videoModel,
      durationSeconds: (runtimeInput.settings as { durationSeconds?: unknown })
        .durationSeconds,
      sceneCount: Array.isArray(
        (runtimeInput.settings as { storyboard?: unknown[] }).storyboard,
      )
        ? (runtimeInput.settings as { storyboard: unknown[] }).storyboard
            .length
        : 0,
      scenes: (
        (runtimeInput.settings as { storyboard?: unknown[] }).storyboard ?? []
      ).map((scene, index) => {
        const s = scene as Record<string, unknown>;
        return {
          index,
          durationSeconds: s.duration,
          carryPreviousFrame: s.carryPreviousFrame,
          transition: s.transition,
          keyframeCount: Array.isArray(s.keyframes) ? s.keyframes.length : 0,
        };
      }),
    });
    const sub = await runtime.submitGeneration(runtimeInput);
    const submitted: StoredGeneration = {
      ...preparing,
      runtimeJobId: sub.runtimeJobId,
      updatedAt: nowIso(),
    };
    gens.set(g.id, submitted);
    await persistGeneration(submitted);
    let st = await runtime.getGenerationStatus(sub.runtimeJobId);
    const deadline = Date.now() + runtimeJobTimeoutMs();
    while (!["completed", "failed", "cancelled"].includes(st.state)) {
      if (Date.now() >= deadline) throw new Error("runtime_job_timeout");
      if (gens.get(g.id)?.status === "cancelled") break;
      const current = {
        ...gens.get(g.id)!,
        status: st.state,
        progress: Math.max(0, Math.min(100, st.progress)),
        runtimeMessage: st.message,
        runtimeProgress: publicRuntimeProgress(st),
        updatedAt: nowIso(),
        runtimeJobId: sub.runtimeJobId,
      };
      gens.set(g.id, current);
      await persistGeneration(current);
      await new Promise((r) => setTimeout(r, 2_000));
      st = await runtime.getGenerationStatus(sub.runtimeJobId);
    }
    if (gens.get(g.id)?.status === "cancelled" || st.state === "cancelled") {
      const cancelled: StoredGeneration = {
        ...gens.get(g.id)!,
        status: "cancelled",
        safeErrorMessage: "Cancelled by user",
        updatedAt: nowIso(),
      };
      gens.set(g.id, cancelled);
      await persistGeneration(cancelled);
    } else if (st.state === "completed") {
      await completeGenerationFromRuntime(gens.get(g.id)!, sub.runtimeJobId, st.qualityAssessment);
    } else {
      const runtimeFailure = new Error(st.message ?? "The runtime could not complete this generation.") as Error & { code?: string };
      runtimeFailure.name = "RuntimeGenerationFailure";
      runtimeFailure.code = st.failureCode ?? "runtime_job_failed";
      throw runtimeFailure;
    }
  } catch (e) {
    const currentAssemblyAttempt = Math.max(
      1,
      (gens.get(g.id) ?? g).assemblyRuntimeAttempt ?? 1,
    );
    const recoverableAssemblyLeaseLoss =
      e instanceof RuntimeLeaseUnavailableError &&
      g.settings.operationScope === "assembly" &&
      currentAssemblyAttempt < assemblyRecoveryAttemptLimit();
    if (e instanceof RuntimeCapacityPendingError || recoverableAssemblyLeaseLoss) {
      finishClaim = false;
      const waiting: StoredGeneration = {
        ...(gens.get(g.id) ?? g),
        status: "queued",
        queuePosition: Math.max(1, g.queuePosition ?? 1),
        runtimeMessage: recoverableAssemblyLeaseLoss
          ? "Runtime changed; preparing assembly recovery"
          : "Preparing generation capacity",
        ...(recoverableAssemblyLeaseLoss
          ? { assemblyRuntimeAttempt: currentAssemblyAttempt + 1 }
          : {}),
        safeErrorMessage: undefined,
        updatedAt: nowIso(),
      };
      delete waiting.runtimeJobId;
      gens.set(g.id, waiting);
      await persistGeneration(waiting);
      await requeueQueueItem(item, e.retryAfterSeconds);
      log(recoverableAssemblyLeaseLoss ? "assembly_requeued_after_runtime_change" : "generation_waiting_for_capacity", {
        generationId: g.id,
        retryAfterSeconds: e.retryAfterSeconds,
        queueAttempt: item.attempt,
        ...(recoverableAssemblyLeaseLoss
          ? { assemblyRuntimeAttempt: currentAssemblyAttempt }
          : {}),
      });
      return true;
    }
    const failureCode = operationalErrorCode(e);
    const wallet = wallets.get(g.uid);
    let creditsReturned = false;
    if (!creditLimitsEnabled()) {
      log("generation_credit_release_bypassed", { generationId: g.id });
    } else if (wallet && wallet.reserved >= g.creditCost) {
      try {
        wallets.set(g.uid, releaseCredits(wallet, g.creditCost));
        creditsReturned = true;
      } catch (refundError) {
        log("generation_credit_release_failed", {
          generationId: g.id,
          errorCode: operationalErrorCode(refundError),
        });
      }
    } else {
      log("generation_credit_release_skipped", {
        generationId: g.id,
        reserved: wallet?.reserved ?? 0,
        creditCost: g.creditCost,
      });
    }
    const failed: StoredGeneration = {
      ...(gens.get(g.id) ?? g),
      status: "failed",
      failureCode,
      safeErrorMessage: `${
        failureCode === "runtime_timeout"
          ? "Generation timed out. Please retry when the runtime is available."
          : failureCode === "runtime_authentication"
            ? "Generation access could not be verified. Please retry shortly."
            : failureCode === "runtime_invalid_response"
              ? "The generator returned an invalid response. Your successful work is unchanged."
              : "Generation failed safely. Please retry when the runtime is available."
      }${creditsReturned ? " Credits were returned." : ""}`,
      updatedAt: nowIso(),
    };
    gens.set(g.id, failed);
    await persistGeneration(failed);
    log("generation_failed", {
      generationId: g.id,
      errorCode: operationalErrorCode(e),
      creditsReturned,
    });
  } finally {
    if (finishClaim) await finishQueueItem(item, g.uid);
    await refreshQueueDepth();
    runtimeState = { ...runtimeState, updatedAt: nowIso() };
  }
  return true;
}
export async function processOne(workerId = "local-worker") {
  await processQueueItem(workerId);
}
export function workerConcurrencyLimit(env: NodeJS.ProcessEnv = process.env) {
  return boundedInteger(env.VIDEO_LAB_WORKER_CONCURRENCY, 2, 1, 20);
}
const activeWorkerPromises = new Set<Promise<boolean>>();

function startQueueWorker() {
  let worker: Promise<boolean>;
  worker = processQueueItem(`web-triggered-worker-${nanoid(8)}`).finally(() => {
    activeWorkerPromises.delete(worker);
  });
  activeWorkerPromises.add(worker);
  return worker;
}

const processNextHandler = async (
  _req: express.Request,
  res: express.Response,
) => {
  const availableSlots = Math.max(
    0,
    workerConcurrencyLimit() - activeWorkerPromises.size,
  );
  if (!availableSlots) {
    res.status(202).json({
      ok: true,
      processed: false,
      processedCount: 0,
      capacity: "scheduler_busy",
    });
    return;
  }
  const results = await Promise.all(
    Array.from({ length: availableSlots }, () => startQueueWorker()),
  );
  res.json({
    ok: true,
    processed: results.some(Boolean),
    processedCount: results.filter(Boolean).length,
  });
};
async function internalWorker(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (localAuth) {
    await auth(req, res, next);
    return;
  }
  const expected = process.env.VIDEO_LAB_WORKER_TOKEN?.trim();
  const supplied = req.header("x-video-lab-worker-token")?.trim();
  if (!expected || supplied !== expected) {
    next(
      problem(
        401,
        "worker_auth_required",
        "Internal worker authentication is required",
      ),
    );
    return;
  }
  next();
}
app.post("/v1/internal/process-next", internalWorker, processNextHandler);
if (process.env.NODE_ENV !== "production") {
  app.post("/v1/dev/process-one", auth, processNextHandler);
}
app.use("/v1", (_req, res) => {
  const response = problem(
    404,
    "not_found",
    "API route not found",
    res.locals.requestId,
  );
  res.status(404).type("application/problem+json").json(response);
});
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const isProblem = typeof err === "object" && err && "status" in err;
    if (!isProblem)
      log("unhandled_api_error", {
        method: req.method,
        path: req.path,
        errorClass: err instanceof Error ? err.name : "unknown",
        requestId: res.locals.requestId,
      });
    const parseFailure =
      err instanceof SyntaxError &&
      "type" in err &&
      err.type === "entity.parse.failed";
    const corsFailure =
      err instanceof Error && err.message === "Origin is not allowed";
    const p = isProblem
      ? ({
          ...(err as ReturnType<typeof problem>),
          traceId: res.locals.requestId,
        } as ReturnType<typeof problem>)
      : parseFailure
        ? problem(
            400,
            "invalid_json",
            "Request body contains invalid JSON",
            res.locals.requestId,
          )
        : corsFailure
          ? problem(
              403,
              "origin_forbidden",
              "Request origin is not allowed",
              res.locals.requestId,
            )
          : problem(
              500,
              "internal_error",
              "Unexpected server error",
              res.locals.requestId,
            );
    res.status(p.status).type("application/problem+json").json(p);
  },
);
export const api =
  process.env.NODE_ENV === "test"
    ? app
    : (await import("firebase-functions/v2/https")).onRequest(
        {
          timeoutSeconds: 3600,
          maxInstances: 1,
          secrets: [
            (await import("firebase-functions/params")).defineSecret(
              "VIDEO_LAB_RUNTIME_API_KEY",
            ),
          ],
        },
        app,
      );
