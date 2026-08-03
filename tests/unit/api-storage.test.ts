import { describe, expect, it } from 'vitest';
import { creditLimitsEnabled, firebaseStorageBucket, localAuthEnabled } from '../../apps/api/src/index.js';

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

describe('credit enforcement configuration', () => {
  it('keeps credit limits disabled while the feature is parked', () => {
    expect(creditLimitsEnabled({})).toBe(false);
    expect(creditLimitsEnabled({ CREDIT_LIMITS_ENABLED: 'true' })).toBe(false);
    expect(creditLimitsEnabled({ CREDIT_LIMITS_ENABLED: 'false' })).toBe(false);
  });
});

describe('local authentication boundary', () => {
  it('requires an explicit development opt-in and always fails closed in production', () => {
    expect(localAuthEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(localAuthEnabled({ NODE_ENV: 'development', K_SERVICE: '', VIDEO_LAB_LOCAL_AUTH: 'true' })).toBe(true);
    expect(localAuthEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(localAuthEnabled({ NODE_ENV: 'production', VIDEO_LAB_LOCAL_AUTH: 'true' })).toBe(false);
  });
});
