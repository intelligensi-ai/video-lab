import type { LongFormGenerationPayload } from './api.js';

const DATABASE_NAME = 'intelligensi-video-lab';
const STORE_NAME = 'storyboard-sessions';
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

export async function loadStoryboardSession(ownerId: string) {
  const database = await openDatabase();
  return new Promise<LongFormGenerationPayload | undefined>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(ownerId);
    request.onsuccess = () => resolve((request.result as { form?: LongFormGenerationPayload } | undefined)?.form);
    request.onerror = () => reject(request.error);
  });
}

export async function saveStoryboardSession(ownerId: string, form: LongFormGenerationPayload) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({
      form,
      updatedAt: new Date().toISOString(),
    }, ownerId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
