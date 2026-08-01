import {
  getStoryboardProject,
  updateStoryboardProject,
  type LongFormGenerationPayload,
} from "./api.js";

const DATABASE_NAME = "intelligensi-video-lab";
const STORE_NAME = "storyboard-sessions";
const DATABASE_VERSION = 1;
let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return databasePromise;
}

type LocalStoryboardSession = {
  form: LongFormGenerationPayload;
  updatedAt: string;
};

function sessionKey(ownerId: string, projectId: string) {
  return `${ownerId}:${projectId}`;
}

export async function loadStoryboardSession(
  ownerId: string,
  projectId: string,
) {
  const database = await openDatabase();
  const local = await new Promise<LocalStoryboardSession | undefined>(
    (resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(sessionKey(ownerId, projectId));
      request.onsuccess = () =>
        resolve(request.result as LocalStoryboardSession | undefined);
      request.onerror = () => reject(request.error);
    },
  );
  try {
    const remote = await getStoryboardProject(projectId);
    const remoteForm = remote.form as unknown as LongFormGenerationPayload;
    if (
      local &&
      new Date(local.updatedAt).getTime() >=
        new Date(remote.updatedAt).getTime()
    )
      return local.form;
    return remoteForm;
  } catch {
    return local?.form;
  }
}

export async function saveStoryboardSession(
  ownerId: string,
  projectId: string,
  title: string,
  form: LongFormGenerationPayload,
) {
  const database = await openDatabase();
  const localSave = new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put(
        {
          form,
          updatedAt: new Date().toISOString(),
        },
        sessionKey(ownerId, projectId),
      );
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const serializable = JSON.parse(
    JSON.stringify(form, (_key, value) =>
      value instanceof File ? undefined : value,
    ),
  ) as Record<string, unknown>;
  const [localResult, remoteResult] = await Promise.allSettled([
    localSave,
    updateStoryboardProject(projectId, title, serializable),
  ]);
  if (localResult.status === "rejected" && remoteResult.status === "rejected") {
    throw new Error(
      "Storyboard draft could not be saved locally or to the private workspace.",
    );
  }
}

export async function deleteStoryboardSession(
  ownerId: string,
  projectId: string,
) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .delete(sessionKey(ownerId, projectId));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
