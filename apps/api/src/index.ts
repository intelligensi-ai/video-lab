import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import fs from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { nanoid } from "nanoid";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { MAX_STORYBOARD_SCENES } from "@video-lab/contracts";
import type {
  CreditWallet,
  Generation,
  Me,
  RuntimeStatus,
  StoryboardProject,
  StoryboardProjectSummary,
  StoryboardContinuityBible,
  StoryboardEnhancementRequest,
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
  type RuntimeGenerationInput,
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
type Principal = { uid: string; email: string; admin: boolean };
let runtime = createRuntimeFromEnv();
type StoredGeneration = Generation & {
  uid: string;
  runtimeJobId?: string;
  outputBytes?: Uint8Array;
  outputContentType?: string;
  outputObjectPath?: string;
};
type StoredAsset = {
  id: string;
  uid: string;
  purpose: string;
  objectPath: string;
  contentType: string;
  expectedSize: number;
  createdAt: string;
  expiresAt: string;
  uploadedAt?: string;
  bytes?: Uint8Array;
};
type StoredStoryboardProject = {
  id: string;
  uid: string;
  title: string;
  form: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
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
const assets = new Map<string, StoredAsset>();
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
    outputBytes: _outputBytes,
    outputContentType: _outputContentType,
    outputObjectPath: _outputObjectPath,
    ...generation
  } = g;
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
  };
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
    const runtimeJobIds: string[] = [];
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
        !accepted.runtimeJobId
      ) {
        throw new Error("invalid_assembly_sources");
      }
      runtimeJobIds.push(accepted.runtimeJobId);
    }
    settings.assemblyJobIds = runtimeJobIds;
    delete settings.acceptedSceneGenerationIds;
  }
  return {
    prompt: g.prompt,
    settings,
    inputAssetUrls: [],
    idempotencyKey: `video-lab:${g.id}`,
  };
}
const localAuth =
  process.env.NODE_ENV === "test" ||
  (process.env.NODE_ENV !== "production" && !process.env.K_SERVICE);
const usesIntelligensiRuntimeApi =
  process.env.VIDEO_RUNTIME_PROVIDER === "intelligensi-api";
function normalizeRuntimeBaseUrl(value: unknown) {
  const origin = normalizeRuntimeOrigin(value, {
    production: process.env.NODE_ENV === "production",
    allowPrivate: localAuth,
    allowHttpInProduction: true,
  });
  return origin && runtimeOriginAllowed(origin) ? origin : undefined;
}
let runtimeBaseUrl = normalizeRuntimeBaseUrl(
  process.env.VIDEO_RUNTIME_BASE_URL,
);
type RuntimeDiscovery = NonNullable<RuntimeStatus["discovery"]>;
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
const runtimeDiscoveryRefreshMs = Math.max(
  2_000,
  Number(process.env.VIDEO_RUNTIME_DISCOVERY_REFRESH_MS ?? 10_000),
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
function createRuntimeAdapter(baseUrl: string) {
  return new SulphurLtxRuntimeAdapter({
    baseUrl,
    token: process.env.VIDEO_RUNTIME_API_TOKEN,
    runtimeId:
      process.env.VIDEO_RUNTIME_ID ?? "longform-ltx-storyboard-studio",
    healthPath: usesIntelligensiRuntimeApi
      ? process.env.VIDEO_RUNTIME_HEALTH_PATH
      : process.env.VIDEO_RUNTIME_HEALTH_PATH ?? "/health",
    submitPath: process.env.VIDEO_RUNTIME_SUBMIT_PATH,
    statusPath: process.env.VIDEO_RUNTIME_STATUS_PATH,
    cancelPath: process.env.VIDEO_RUNTIME_CANCEL_PATH,
    outputPath: process.env.VIDEO_RUNTIME_OUTPUT_PATH,
    authHeaderName: process.env.VIDEO_RUNTIME_AUTH_HEADER,
    authScheme: process.env.VIDEO_RUNTIME_AUTH_SCHEME,
    payloadMode: usesIntelligensiRuntimeApi
      ? "intelligensi-api"
      : process.env.VIDEO_RUNTIME_PAYLOAD_MODE === "sulphur"
        ? "sulphur"
        : "deploy-studio",
    timeoutMs: Number(process.env.VIDEO_RUNTIME_TIMEOUT_MS ?? 120000),
  });
}
async function connectRuntimeEndpoint(
  baseUrl: string,
  source: RuntimeDiscovery["source"],
  message: string,
) {
  const adapter = createRuntimeAdapter(baseUrl);
  let health: Awaited<ReturnType<SulphurLtxRuntimeAdapter["healthCheck"]>>;
  try {
    health = await adapter.healthCheck();
  } catch (e) {
    const detail =
      e instanceof Error && e.name === "AbortError"
        ? "Runtime health check timed out"
        : e instanceof Error
          ? e.message
          : String(e);
    throw problem(
      503,
      "runtime_health_unreachable",
      `Could not reach runtime health endpoint: ${detail}`,
    );
  }
  if (!health.ok)
    throw problem(
      503,
      "runtime_health_failed",
      "Runtime health check did not report ready",
    );
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
) {
  if (runtimeBaseUrl !== baseUrl) {
    runtimeBaseUrl = baseUrl;
    runtime = createRuntimeAdapter(baseUrl);
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
  if (usesIntelligensiRuntimeApi && runtimeBaseUrl) {
    runtimeDiscoveryCheckedAt = Date.now();
    const discovered =
      runtime instanceof SulphurLtxRuntimeAdapter
        ? await runtime.discoverReadyRuntime("storyboard-enhance")
        : undefined;
    if (!discovered) {
      runtimeDiscovery = {
        source: "deploy-studio",
        state: "waiting",
        message:
          "Waiting for Deploy Studio to report a ready LongForm runtime through the gateway",
      };
      if (runtimeState.status !== "paused" && !runtimeState.killSwitch)
        runtimeState = {
          ...runtimeState,
          status: "unavailable",
          acceptingSubmissions: false,
          updatedAt: nowIso(),
        };
      return;
    }
    useRuntimeEndpoint(runtimeBaseUrl, "deploy-studio");
    runtimeDiscovery = {
      source: "deploy-studio",
      state: "connected",
      message: `Connected through Deploy Studio runtime API (${discovered.runtimeId})`,
    };
    return;
  }
  if (localAuth) return;
  const now = Date.now();
  if (!force && now - runtimeDiscoveryCheckedAt < runtimeDiscoveryRefreshMs)
    return;
  if (runtimeDiscoveryPromise) return runtimeDiscoveryPromise;
  runtimeDiscoveryPromise = (async () => {
    adminApp();
    const firestore = getFirestore();
    const snapshot = await firestore
      .collection(
        process.env.VIDEO_RUNTIME_DISCOVERY_COLLECTION ?? "runtimeDiscovery",
      )
      .doc(process.env.VIDEO_RUNTIME_DISCOVERY_DOCUMENT ?? "current")
      .get();
    runtimeDiscoveryCheckedAt = Date.now();
    if (snapshot.exists) {
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
          useRuntimeEndpoint(manualRuntimeBaseUrl, "environment");
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
          useRuntimeEndpoint(manualRuntimeBaseUrl, "environment");
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
        useRuntimeEndpoint(manualRuntimeBaseUrl, "environment");
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
  return {
    ...runtimeState,
    provider: runtimeState.provider === "mock" ? "mock" : "managed-longform",
    queueDepth: localAuth
      ? queue.filter((q) => q.status !== "done").length
      : runtimeState.queueDepth,
    discovery: runtimeDiscovery,
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
    .set(clean, { merge: true });
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

function queueLeaseMs() {
  const timeout = Math.max(
    60_000,
    Number(process.env.VIDEO_RUNTIME_JOB_TIMEOUT_MS ?? 55 * 60_000),
  );
  return Math.min(2 * 60 * 60_000, timeout + 5 * 60_000);
}

async function claimQueueItem(
  workerId: string,
): Promise<QueueItem | undefined> {
  if (localAuth) return claimNext(queue, workerId, new Date(), queueLeaseMs());
  adminApp();
  const firestore = getFirestore();
  const queued = await firestore
    .collection(generationQueueCollection)
    .where("status", "==", "queued")
    .orderBy("createdAt", "asc")
    .limit(10)
    .get();
  const expired = queued.empty
    ? await firestore
        .collection(generationQueueCollection)
        .where("status", "==", "claimed")
        .where("leaseExpiresAt", "<", nowIso())
        .orderBy("leaseExpiresAt", "asc")
        .limit(10)
        .get()
    : undefined;
  for (const candidate of [...queued.docs, ...(expired?.docs ?? [])]) {
    let claimed: QueueItem | undefined;
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(candidate.ref);
      if (!snapshot.exists) return;
      const item = snapshot.data() as QueueItem;
      const eligible =
        item.status === "queued" ||
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
      };
      transaction.update(candidate.ref, {
        status: claimed.status,
        claimedBy: claimed.claimedBy,
        attempt: claimed.attempt,
        leaseExpiresAt: claimed.leaseExpiresAt,
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

async function refreshQueueDepth() {
  if (localAuth) {
    runtimeState.queueDepth = queue.filter(
      (item) => item.status !== "done",
    ).length;
    return;
  }
  adminApp();
  const snapshot = await getFirestore()
    .collection("runtimeState")
    .doc(queueMetricsDocument)
    .get();
  runtimeState.queueDepth = Math.max(
    0,
    Number(snapshot.data()?.outstanding ?? 0),
  );
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw problem(
      400,
      "invalid_storyboard",
      "Storyboard enhancement input is required",
    );
  }
  const source = value as Record<string, unknown>;
  const masterPrompt =
    typeof source.masterPrompt === "string" ? source.masterPrompt.trim() : "";
  const shotCount = Number(source.shotCount);
  if (masterPrompt.length < 3 || masterPrompt.length > 12_000) {
    throw problem(
      400,
      "invalid_master_prompt",
      "Master prompt must be 3-12000 characters",
    );
  }
  if (
    !Number.isInteger(shotCount) ||
    shotCount < 1 ||
    shotCount > MAX_STORYBOARD_SCENES
  ) {
    throw problem(
      400,
      "invalid_shot_count",
      `Shot count must be 1-${MAX_STORYBOARD_SCENES}`,
    );
  }
  const mode = ["text_to_video", "image_to_video", "mixed"].includes(
    String(source.generationMode),
  )
    ? (source.generationMode as StoryboardEnhancementRequest["generationMode"])
    : "text_to_video";
  const rawBible =
    source.continuityBible &&
    typeof source.continuityBible === "object" &&
    !Array.isArray(source.continuityBible)
      ? (source.continuityBible as Record<string, unknown>)
      : {};
  const continuityBible = Object.fromEntries(
    continuityKeys.map((key) => [
      key,
      typeof rawBible[key] === "string"
        ? rawBible[key].trim().slice(0, 4_000)
        : "",
    ]),
  ) as unknown as StoryboardContinuityBible;
  if (!Array.isArray(source.shots) || source.shots.length !== shotCount) {
    throw problem(
      400,
      "invalid_storyboard",
      "The shot blueprint must match the selected shot count",
    );
  }
  const shots = source.shots.map((entry, index) => {
    const shot =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    if (Number(shot.shotNumber) !== index + 1) {
      throw problem(
        400,
        "invalid_storyboard",
        "Shot numbers must be unique, contiguous and ordered",
      );
    }
    return {
      shotNumber: index + 1,
      title:
        typeof shot.title === "string"
          ? shot.title.trim().slice(0, 160)
          : `Shot ${index + 1}`,
      prompt:
        typeof shot.prompt === "string"
          ? shot.prompt.trim().slice(0, 12_000)
          : "",
      durationSeconds: Math.min(
        8,
        Math.max(1, Math.round(Number(shot.durationSeconds) || 5)),
      ),
      generationMode: ["text_to_video", "image_to_video", "mixed"].includes(
        String(shot.generationMode),
      )
        ? (shot.generationMode as StoryboardEnhancementRequest["generationMode"])
        : mode,
    };
  });
  const rawTarget = source.targetShotNumber;
  const targetShotNumber =
    rawTarget === undefined ? undefined : Number(rawTarget);
  if (
    targetShotNumber !== undefined &&
    (!Number.isInteger(targetShotNumber) ||
      targetShotNumber < 1 ||
      targetShotNumber > shotCount)
  ) {
    throw problem(
      400,
      "invalid_target_shot",
      "Target shot is outside the storyboard",
    );
  }
  return {
    masterPrompt,
    shotCount,
    generationMode: mode,
    continuityBible,
    shots,
    targetShotNumber,
  };
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
  "firstFramePrompt",
  "lastFramePrompt",
  "narrativePurpose",
  "continuityNotes",
  "promptOrigin",
  "staleReason",
]);

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
    return scene;
  });
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

async function enhanceStoryboard(request: StoryboardEnhancementRequest) {
  const useStableApi = usesIntelligensiRuntimeApi;
  const baseUrl = useStableApi
    ? normalizeRuntimeBaseUrl(process.env.VIDEO_RUNTIME_BASE_URL)
    : normalizeRuntimeOrigin(process.env.VIDEO_DEPLOY_STUDIO_BASE_URL, {
        production: process.env.NODE_ENV === "production",
        allowPrivate: localAuth,
      });
  const token = (
    useStableApi
      ? process.env.VIDEO_RUNTIME_API_TOKEN
      : process.env.VIDEO_DEPLOY_STUDIO_API_TOKEN
  )?.trim();
  if (baseUrl && token) {
    return new DeployStudioStoryboardEnhancerClient({
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
      timeoutMs: Number(
        process.env.VIDEO_STORYBOARD_ENHANCER_TIMEOUT_MS ?? 100_000,
      ),
    }).enhance(request);
  }
  if (localAuth || process.env.VIDEO_STORYBOARD_ENHANCER_PROVIDER === "mock") {
    return mockStoryboardEnhancement(request);
  }
  throw problem(
    503,
    "storyboard_enhancer_unavailable",
    "Prompt enhancement is temporarily unavailable; your original prompts are unchanged",
  );
}

export const app: express.Express = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
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
    limit: Number(process.env.VIDEO_LAB_RATE_LIMIT_PER_MINUTE ?? 180),
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
    const project: StoredStoryboardProject = {
      id: nanoid(),
      uid: res.locals.principal.uid,
      title: storyboardProjectTitle(req.body?.title),
      form: sanitizeStoryboardDraft(req.body?.form),
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
    res.json(
      await persistStoryboardProject({
        ...existing,
        title: storyboardProjectTitle(req.body?.title),
        form: sanitizeStoryboardDraft(req.body?.form),
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
      const request = enhancementRequest(req.body);
      const result = await enhanceStoryboard(request);
      log("storyboard_enhanced", {
        uid: res.locals.principal.uid,
        shotCount: request.shotCount,
        targeted: request.targetShotNumber !== undefined,
        provider: result.provider,
        model: result.model,
      });
      res.json(result);
    } catch (error) {
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
        error.message === "storyboard_enhancement_failed"
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
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const objectPath = `users/${res.locals.principal.uid}/uploads/${assetId}-${String(fileName).replace(/[^\w.-]/g, "_")}`;
    await persistAsset({
      id: assetId,
      uid: res.locals.principal.uid,
      purpose,
      objectPath,
      contentType,
      expectedSize: sizeBytes,
      createdAt: nowIso(),
      expiresAt,
    });
    res.status(201).json({
      assetId,
      uploadUrl: `/v1/assets/${assetId}/content`,
      method: "PUT",
      expiresAt,
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
        new Date(asset.expiresAt).getTime() <= Date.now() ||
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
      asset.uploadedAt = nowIso();
      if (localAuth) asset.bytes = body;
      else {
        adminApp();
        await getStorage()
          .bucket()
          .file(asset.objectPath)
          .save(body, {
            resumable: false,
            contentType: asset.contentType,
            metadata: { cacheControl: "private,no-store" },
          });
        await persistAsset(asset);
      }
      log("asset_uploaded", {
        uid: asset.uid,
        assetId: req.params.id,
        purpose: asset.purpose,
        sizeBytes: body.length,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);
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
        });
      }
      const projectId = String(
        (settings as { projectId?: unknown }).projectId ?? "",
      );
      if (projectId) {
        const project = await findStoryboardProject(p.uid, projectId);
        if (!project)
          throw problem(404, "project_not_found", "Project not found");
      }
      if (Object.prototype.hasOwnProperty.call(settings, "assemblyJobIds"))
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
            accepted.settings.projectId !== projectId
          )
            throw problem(
              400,
              "invalid_assembly_sources",
              "An accepted scene clip is missing, stale or not owned by you",
            );
        }
      }
      const globalQueueLimit = Math.max(
        1,
        Number(process.env.VIDEO_RUNTIME_GLOBAL_QUEUE_LIMIT ?? 100),
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
app.post("/v1/generations/:id/cancel", auth, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    const g = await findGeneration(id);
    if (!g || g.uid !== res.locals.principal.uid)
      throw problem(404, "not_found", "Generation not found");
    if (["completed", "failed", "cancelled"].includes(g.status))
      return res.json(publicGeneration(g));
    if (g.runtimeJobId) {
      try {
        await runtime.cancelGeneration(g.runtimeJobId);
      } catch (e) {
        log("runtime_cancel_failed", {
          generationId: g.id,
          errorCode: operationalErrorCode(e),
        });
      }
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
app.get("/v1/gallery", auth, async (req, res, next) => {
  try {
    const p = res.locals.principal as Principal;
    const status = req.query.status;
    if (!localAuth) {
      adminApp();
      let query = getFirestore()
        .collection("generations")
        .where("uid", "==", p.uid)
        .orderBy("createdAt", "desc")
        .limit(Number(req.query.limit ?? 20));
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
      .slice(0, Number(req.query.limit ?? 20))
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
  try {
    const preparing = {
      ...g,
      status: "preparing" as const,
      updatedAt: nowIso(),
    };
    gens.set(g.id, preparing);
    await persistGeneration(preparing);
    const sub = await runtime.submitGeneration(await runtimeGeneration(g));
    const submitted: StoredGeneration = {
      ...preparing,
      runtimeJobId: sub.runtimeJobId,
      updatedAt: nowIso(),
    };
    gens.set(g.id, submitted);
    await persistGeneration(submitted);
    let st = await runtime.getGenerationStatus(sub.runtimeJobId);
    const deadline =
      Date.now() +
      Math.max(
        60_000,
        Number(process.env.VIDEO_RUNTIME_JOB_TIMEOUT_MS ?? 55 * 60_000),
      );
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
      const out = await runtime.fetchOutput(sub.runtimeJobId);
      if (creditLimitsEnabled())
        wallets.set(g.uid, chargeCredits(wallets.get(g.uid)!, g.creditCost));
      const extension =
        out.contentType === "image/png"
          ? "png"
          : out.contentType === "image/jpeg"
            ? "jpg"
            : out.contentType === "image/webp"
              ? "webp"
              : out.contentType === "video/webm"
                ? "webm"
                : "mp4";
      const outputObjectPath = `users/${g.uid}/outputs/${g.id}.${extension}`;
      if (!localAuth) {
        adminApp();
        await getStorage()
          .bucket()
          .file(outputObjectPath)
          .save(Buffer.from(out.bytes), {
            resumable: false,
            contentType: out.contentType,
            metadata: { cacheControl: "private,no-store" },
          });
      }
      const completed: StoredGeneration = {
        ...gens.get(g.id)!,
        status: "completed",
        progress: 100,
        runtimeMessage: undefined,
        runtimeProgress: undefined,
        output: {
          downloadUrl: `/api/v1/generations/${g.id}/download`,
          durationSeconds: out.durationSeconds,
          contentType: out.contentType,
          kind: out.contentType.startsWith("image/") ? "frame" : "video",
        },
        ...(localAuth ? { outputBytes: out.bytes } : {}),
        outputObjectPath,
        outputContentType: out.contentType,
        updatedAt: nowIso(),
      };
      gens.set(g.id, completed);
      await persistGeneration(completed);
      log("runtime_generation_completed", {
        generationId: g.id,
        outputObjectPath,
      });
    } else throw new Error(st.message ?? st.state);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
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
      safeErrorMessage: localAuth
        ? `Generation failed: ${detail}.${creditsReturned ? " Credits were returned." : ""}`
        : "Generation failed safely. Please retry when the runtime is available.",
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
    await finishQueueItem(item, g.uid);
    await refreshQueueDepth();
    runtimeState = { ...runtimeState, updatedAt: nowIso() };
  }
  return true;
}
export async function processOne(workerId = "local-worker") {
  await processQueueItem(workerId);
}
let workerPromise: Promise<void> | undefined;
async function drainQueue() {
  while (await processQueueItem("web-triggered-worker")) {
    // Keep claiming durable work until the queue has no eligible items.
  }
}
const processNextHandler = async (
  _req: express.Request,
  res: express.Response,
) => {
  if (!workerPromise)
    workerPromise = drainQueue().finally(() => {
      workerPromise = undefined;
    });
  await workerPromise;
  res.json({ ok: true });
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
        { timeoutSeconds: 3600, maxInstances: 1 },
        app,
      );
