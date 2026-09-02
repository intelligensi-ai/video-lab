import { describe, expect, it } from 'vitest';
import {
  creditLimitsEnabled,
  firebaseStorageBucket,
  localAuthEnabled,
  validateRuntimeAuthenticationEnv,
} from '../../apps/api/src/index.js';

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

describe('runtime authentication configuration', () => {
  it('accepts the canonical Intelligensi runtime gateway configuration', () => {
    expect(validateRuntimeAuthenticationEnv({
      VIDEO_RUNTIME_PROVIDER: 'intelligensi-api',
      VIDEO_RUNTIME_BASE_URL: 'https://api.intelligensi.ai',
      VIDEO_RUNTIME_ID: 'longform-ltx-storyboard-studio',
      VIDEO_RUNTIME_PAYLOAD_MODE: 'intelligensi-api',
      VIDEO_RUNTIME_AUTH_HEADER: 'X-Intelligensi-API-Key',
      VIDEO_RUNTIME_AUTH_SCHEME: 'none',
      VIDEO_LAB_RUNTIME_API_KEY: 'server-only-test-key',
    })).toEqual({ ok: true, issues: [] });
  });

  it('reports missing or unsafe Intelligensi runtime gateway settings without secret values', () => {
    const result = validateRuntimeAuthenticationEnv({
      VIDEO_RUNTIME_PROVIDER: 'intelligensi-api',
      VIDEO_RUNTIME_BASE_URL: 'https://worker.example.test',
      VIDEO_RUNTIME_ID: 'wrong-runtime',
      VIDEO_RUNTIME_PAYLOAD_MODE: 'deploy-studio',
      VIDEO_RUNTIME_AUTH_HEADER: 'authorization',
      VIDEO_RUNTIME_AUTH_SCHEME: 'Bearer',
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      'VIDEO_RUNTIME_BASE_URL must be https://api.intelligensi.ai',
      'VIDEO_RUNTIME_ID must be longform-ltx-storyboard-studio',
      'VIDEO_RUNTIME_PAYLOAD_MODE must be intelligensi-api',
      'VIDEO_RUNTIME_AUTH_HEADER must be X-Intelligensi-API-Key',
      'VIDEO_RUNTIME_AUTH_SCHEME must be none',
      'VIDEO_LAB_RUNTIME_API_KEY must be configured server-side',
    ]);
    expect(JSON.stringify(result)).not.toContain('server-only-test-key');
  });
});
