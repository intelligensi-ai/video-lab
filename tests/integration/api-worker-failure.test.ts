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
  }, 15_000);

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
  }, 15_000);

  it('rebuilds an assembly from canonical Video Lab artifacts after its runtime lease is replaced', async () => {
    vi.stubEnv('VIDEO_RUNTIME_PROVIDER', 'intelligensi-api');
    vi.stubEnv('VIDEO_RUNTIME_BASE_URL', 'https://api.intelligensi.test');
    vi.stubEnv('VIDEO_RUNTIME_PAYLOAD_MODE', 'intelligensi-api');
    vi.stubEnv('VIDEO_LAB_ASSEMBLY_RECOVERY_ATTEMPTS', '2');
    const submittedAssemblyBodies: Array<Record<string, unknown>> = [];
    const submittedAssemblyKeys: string[] = [];
    let sceneJobNumber = 0;
    let assemblySubmission = 0;
    let assemblyCapacityPending = true;
    let permanentAssemblyFailure = false;
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/capacity-demand')) return Response.json({ accepted: true }, { status: 202 });
      if (url.includes('/v1/runtimes?')) return Response.json({
        runtimes: [{ runtimeId: 'longform-ltx-storyboard-studio', status: 'ready', ready: true }],
      });
      if (url.endsWith('/health')) return Response.json({
        runtimeId: 'longform-ltx-storyboard-studio',
        status: 'ready',
        ready: true,
        features: {
          maxScenes: 24,
          maxSceneDurationSeconds: 8,
          workflowModes: ['text', 'start', 'start_end'],
          operationScopes: ['project', 'scene', 'start_frame', 'end_frame', 'assembly'],
          postProcess: ['none', 'interpolate', 'upscale', 'both'],
          startFrame: true,
          endFrame: true,
          generatedOpeningFrame: true,
          previousFrameContinuity: true,
          sceneAssembly: true,
          audioPreservation: true,
          styleReference: false,
          subjectReference: false,
        },
      });
      if (url.endsWith('/preview') && (init?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.operation_scope === 'assembly') {
          assemblySubmission += 1;
          submittedAssemblyBodies.push(body);
          submittedAssemblyKeys.push(String((init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? ''));
          if (assemblyCapacityPending) {
            assemblyCapacityPending = false;
            return Response.json({ code: 'runtime_capacity_pending' }, {
              status: 429,
              headers: { 'Retry-After': '1' },
            });
          }
          return Response.json({
            id: permanentAssemblyFailure
              ? `assembly-unavailable-${assemblySubmission}`
              : assemblySubmission === 2
                ? 'assembly-old-worker'
                : 'assembly-new-worker',
          }, { status: 202 });
        }
        sceneJobNumber += 1;
        return Response.json({ id: `scene-runtime-job-${sceneJobNumber}` }, { status: 202 });
      }
      if (url.includes('/jobs/assembly-old-worker') || url.includes('/jobs/assembly-unavailable-')) return Response.json({
        code: 'job_not_found',
        detail: 'private terminated worker details',
      }, { status: 404, headers: { 'Retry-After': '1' } });
      if (url.endsWith('/output')) return new Response('durable private mp4 bytes', {
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'X-Video-Duration-Seconds': '4' },
      });
      if (url.includes('/jobs/')) return Response.json({ status: 'completed', progress: 1 });
      throw new Error(`Unexpected test request: ${url}`);
    }));

    const { app, processOne } = await import('../../apps/api/src/index.js');
    const owner = 'assembly-recovery-owner';
    const auth = { authorization: `Bearer ${owner}` };
    const scenes = [1, 2].map((number) => ({
      id: `scene-${number}`,
      title: `Scene ${number}`,
      prompt: `A production direction for scene ${number}.`,
      duration: 4,
      trimStart: 0,
      trimEnd: 4,
      seed: 1336 + number,
      transition: number === 1 ? 'cut' : 'crossfade',
      transitionDuration: 0.75,
      carryPreviousFrame: number > 1,
    }));
    const form = {
      overallGoal: 'A two-scene provider replacement recovery film',
      resolution: '1024x576',
      fps: 24,
      globalSeed: 1337,
      seedPolicy: 'global_locked',
      scenes,
    };
    const project = await request(app)
      .post('/v1/storyboards/projects')
      .set(auth)
      .send({ title: 'Provider replacement recovery', form })
      .expect(201);
    const acceptedSceneGenerationIds: string[] = [];
    for (const scene of scenes) {
      const submitted = await request(app)
        .post('/v1/generations')
        .set(auth)
        .set('Idempotency-Key', `recovery-${scene.id}`)
        .send({
          prompt: scene.prompt,
          settings: {
            runtime: 'longform-ltx-storyboard-studio',
            aspectRatio: '16:9',
            durationSeconds: scene.duration,
            quality: 'draft',
            projectId: project.body.id,
            operationScope: 'scene',
            operationSceneId: scene.id,
            overallGoal: form.overallGoal,
            resolution: form.resolution,
            fps: form.fps,
            storyboard: [scene],
          },
          inputAssets: [],
        })
        .expect(201);
      await processOne(`recovery-scene-${scene.id}`);
      acceptedSceneGenerationIds.push(submitted.body.id);
    }
    const assembly = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'provider-replacement-assembly')
      .send({
        prompt: form.overallGoal,
        settings: {
          runtime: 'longform-ltx-storyboard-studio',
          aspectRatio: '16:9',
          durationSeconds: 8,
          quality: 'draft',
          projectId: project.body.id,
          operationScope: 'assembly',
          acceptedSceneGenerationIds,
          storyboard: scenes,
        },
        inputAssets: [],
      })
      .expect(201);

    await processOne('assembly-capacity-wait');
    const capacityWaiting = await request(app).get(`/v1/generations/${assembly.body.id}`).set(auth).expect(200);
    expect(capacityWaiting.body).toMatchObject({
      status: 'queued',
      runtimeMessage: 'Preparing generation capacity',
    });
    expect(capacityWaiting.body).not.toHaveProperty('assemblyRuntimeAttempt');

    await processOne('assembly-old-worker');
    const waiting = await request(app).get(`/v1/generations/${assembly.body.id}`).set(auth).expect(200);
    expect(waiting.body).toMatchObject({
      status: 'queued',
      runtimeMessage: 'Runtime changed; preparing assembly recovery',
    });
    expect(waiting.body).not.toHaveProperty('assemblyRuntimeAttempt');
    expect(JSON.stringify(waiting.body)).not.toContain('assembly-old-worker');

    await processOne('assembly-replacement-worker');
    const completed = await request(app).get(`/v1/generations/${assembly.body.id}`).set(auth).expect(200);
    expect(completed.body).toMatchObject({
      status: 'completed',
      output: { kind: 'video', contentType: 'video/mp4' },
    });
    expect(submittedAssemblyBodies).toHaveLength(3);
    for (const body of submittedAssemblyBodies) {
      expect(body).not.toHaveProperty('assembly_job_ids');
      expect(body).toMatchObject({
        assembly_sources: [
          expect.objectContaining({ content_type: 'video/mp4', size_bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ content_type: 'video/mp4', size_bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        ],
      });
      expect(JSON.stringify(body)).not.toContain('private terminated worker details');
    }
    expect(submittedAssemblyKeys[0]).toMatch(/assembly-attempt-1$/);
    expect(submittedAssemblyKeys[1]).toMatch(/assembly-attempt-1$/);
    expect(submittedAssemblyKeys[2]).toMatch(/assembly-attempt-2$/);

    permanentAssemblyFailure = true;
    const exhaustedAssembly = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'provider-replacement-assembly-exhausted')
      .send({
        prompt: form.overallGoal,
        settings: {
          runtime: 'longform-ltx-storyboard-studio',
          aspectRatio: '16:9',
          durationSeconds: 8,
          quality: 'draft',
          projectId: project.body.id,
          operationScope: 'assembly',
          acceptedSceneGenerationIds,
          storyboard: scenes,
        },
        inputAssets: [],
      })
      .expect(201);
    await processOne('assembly-unavailable-first');
    await request(app)
      .get(`/v1/generations/${exhaustedAssembly.body.id}`)
      .set(auth)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('queued'));
    await processOne('assembly-unavailable-second');
    const exhausted = await request(app)
      .get(`/v1/generations/${exhaustedAssembly.body.id}`)
      .set(auth)
      .expect(200);
    expect(exhausted.body.status).toBe('failed');
    expect(JSON.stringify(exhausted.body)).not.toContain('private terminated worker details');
    expect(submittedAssemblyKeys[3]).toMatch(/assembly-attempt-1$/);
    expect(submittedAssemblyKeys[4]).toMatch(/assembly-attempt-2$/);
  }, 20_000);
});
