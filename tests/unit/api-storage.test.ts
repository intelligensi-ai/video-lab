import { describe, expect, it } from 'vitest';
import { firebaseStorageBucket } from '../../apps/api/src/index.js';

describe('Firebase Storage configuration', () => {
  it('reads the deployed bucket from FIREBASE_CONFIG', () => {
    expect(firebaseStorageBucket({
      FIREBASE_CONFIG: JSON.stringify({
        projectId: 'video-lab',
        storageBucket: 'video-lab.firebasestorage.app',
      }),
    })).toBe('video-lab.firebasestorage.app');
  });

  it('uses an explicit bucket before FIREBASE_CONFIG', () => {
    expect(firebaseStorageBucket({
      FIREBASE_STORAGE_BUCKET: 'explicit.appspot.com',
      FIREBASE_CONFIG: JSON.stringify({ storageBucket: 'ignored.appspot.com' }),
    })).toBe('explicit.appspot.com');
  });

  it('derives the modern default bucket from the project id', () => {
    expect(firebaseStorageBucket({
      GCLOUD_PROJECT: 'video-lab',
      FIREBASE_CONFIG: 'not-json',
    })).toBe('video-lab.firebasestorage.app');
  });
});
