import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

describe('generation worker failure handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('persists a failed status when the runtime submission times out', async () => {
    vi.stubEnv('VIDEO_RUNTIME_PROVIDER', 'sulphur-ltx');
    vi.stubEnv('VIDEO_RUNTIME_BASE_URL', 'http://runtime.test');
    vi.stubEnv('VIDEO_RUNTIME_PAYLOAD_MODE', 'deploy-studio');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('runtime timeout');
    }));

    const { app, processOne } = await import('../../apps/api/src/index.js');
    const auth = { authorization: 'Bearer worker-failure-user' };
    const submitted = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'worker-failure-key')
      .send({
        prompt: 'A cinematic render that exercises timeout cleanup',
        settings: { aspectRatio: '16:9', durationSeconds: 4, quality: 'draft' },
      })
      .expect(201);

    await expect(processOne('failure-test')).resolves.toBeUndefined();

    const generation = await request(app)
      .get(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(200);

    expect(generation.body.status).toBe('failed');
    expect(generation.body.safeErrorMessage).toContain('runtime timeout');
  });

  it('returns a claimed generation to the durable queue when the pool is full', async () => {
    vi.stubEnv('VIDEO_RUNTIME_PROVIDER', 'intelligensi-api');
    vi.stubEnv('VIDEO_RUNTIME_BASE_URL', 'https://api.intelligensi.test');
    vi.stubEnv('VIDEO_RUNTIME_PAYLOAD_MODE', 'intelligensi-api');
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('capacity-demand')) return Response.json({ accepted: true, observedAt: new Date().toISOString() }, { status: 202 });
      if (url.includes('/v1/runtimes?')) return Response.json({ runtimes: [{ runtimeId: 'longform-ltx-storyboard-studio', status: 'ready', ready: true }] });
      if (url.endsWith('/health')) return Response.json({ ok: true, ready: true, worker: 'longform-ltx-storyboard-studio' });
      return Response.json({ code: 'runtime_capacity_pending' }, { status: 429, headers: { 'Retry-After': '20' } });
    }));

    const { app, processOne } = await import('../../apps/api/src/index.js');
    const auth = { authorization: 'Bearer capacity-wait-user' };
    const submitted = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'capacity-wait-key')
      .send({
        prompt: 'A cinematic render that waits safely for another GPU',
        settings: { aspectRatio: '16:9', durationSeconds: 4, quality: 'draft' },
      })
      .expect(201);

    await expect(processOne('capacity-wait-test')).resolves.toBeUndefined();
    const generation = await request(app)
      .get(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(200);

    expect(generation.body.status).toBe('queued');
    expect(generation.body.runtimeMessage).toBe('Preparing generation capacity');
    expect(generation.body.safeErrorMessage).toBeUndefined();
  });
});
