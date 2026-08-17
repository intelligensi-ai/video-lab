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
    expect(generation.body.failureCode).toBe('runtime_timeout');
    expect(generation.body.safeErrorMessage).toBe(
      'Generation timed out. Please retry when the runtime is available.',
    );
    expect(JSON.stringify(generation.body)).not.toContain('runtime.test');
  }, 15_000);

  it('preserves an active job when runtime cancellation cannot be confirmed', async () => {
    vi.stubEnv('VIDEO_RUNTIME_PROVIDER', 'sulphur-ltx');
    vi.stubEnv('VIDEO_RUNTIME_BASE_URL', 'http://runtime.test');
    vi.stubEnv('VIDEO_RUNTIME_PAYLOAD_MODE', 'deploy-studio');
    let terminal = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/jobs') && init?.method === 'POST') {
        return Response.json({ id: 'uncancellable-runtime-job' }, { status: 202 });
      }
      if (requestUrl.endsWith('/jobs/uncancellable-runtime-job/cancel')) {
        terminal = true;
        return Response.json(
          { error: 'private worker cancellation failure at http://10.0.0.8' },
          { status: 503 },
        );
      }
      if (requestUrl.endsWith('/jobs/uncancellable-runtime-job')) {
        return terminal
          ? Response.json({
              status: 'failed',
              error: {
                code: 'runtime_job_failed',
                title: 'private worker path /workspace/job.json',
              },
            })
          : Response.json({ status: 'running', progress: 10 });
      }
      throw new Error(`Unexpected test URL: ${requestUrl}`);
    }));

    const { app, processOne } = await import('../../apps/api/src/index.js');
    const auth = { authorization: 'Bearer cancel-failure-user' };
    const submitted = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'cancel-failure-key')
      .send({
        prompt: 'A bounded cancellation failure test',
        settings: { aspectRatio: '16:9', durationSeconds: 4, quality: 'draft' },
      })
      .expect(201);

    const worker = processOne('uncancellable-worker');
    await vi.waitFor(async () => {
      const current = await request(app)
        .get(`/v1/generations/${submitted.body.id}`)
        .set(auth);
      expect(current.body.status).toBe('generating');
    });

    const cancellation = await request(app)
      .post(`/v1/generations/${submitted.body.id}/cancel`)
      .set(auth)
      .expect(503);
    expect(cancellation.body.code).toBe('runtime_cancel_unconfirmed');
    expect(JSON.stringify(cancellation.body)).not.toMatch(/10\.0\.0\.8|workspace|runtime\.test/i);

    const deletion = await request(app)
      .delete(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(503);
    expect(deletion.body.code).toBe('runtime_cancel_unconfirmed');
    await request(app)
      .get(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(200);

    await worker;
    const failed = await request(app)
      .get(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(200);
    expect(failed.body.status).toBe('failed');
    expect(JSON.stringify(failed.body)).not.toMatch(/10\.0\.0\.8|workspace|runtime\.test/i);
  }, 15_000);

  it('keeps an accepted cancellation active until the runtime confirms it stopped', async () => {
    vi.stubEnv('VIDEO_RUNTIME_PROVIDER', 'sulphur-ltx');
    vi.stubEnv('VIDEO_RUNTIME_BASE_URL', 'http://runtime.test');
    vi.stubEnv('VIDEO_RUNTIME_PAYLOAD_MODE', 'deploy-studio');
    let statusChecks = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/jobs') && init?.method === 'POST') {
        return Response.json({ id: 'slow-cancel-runtime-job' }, { status: 202 });
      }
      if (requestUrl.endsWith('/jobs/slow-cancel-runtime-job/cancel')) {
        return Response.json({ status: 'cancelling' }, { status: 202 });
      }
      if (requestUrl.endsWith('/jobs/slow-cancel-runtime-job')) {
        statusChecks += 1;
        return Response.json(
          statusChecks >= 3
            ? { status: 'cancelled', progress: 0 }
            : { status: 'running', progress: 25 },
        );
      }
      throw new Error(`Unexpected test URL: ${requestUrl}`);
    }));

    const { app, processOne } = await import('../../apps/api/src/index.js');
    const auth = { authorization: 'Bearer slow-cancel-user' };
    const submitted = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'slow-cancel-key')
      .send({
        prompt: 'A cancellation confirmation boundary test',
        settings: { aspectRatio: '16:9', durationSeconds: 4, quality: 'draft' },
      })
      .expect(201);

    const worker = processOne('slow-cancel-worker');
    await vi.waitFor(async () => {
      const current = await request(app)
        .get(`/v1/generations/${submitted.body.id}`)
        .set(auth);
      expect(current.body.status).toBe('generating');
    });

    const cancellation = await request(app)
      .post(`/v1/generations/${submitted.body.id}/cancel`)
      .set(auth)
      .expect(202);
    expect(cancellation.body.status).toBe('generating');
    expect(cancellation.body.runtimeMessage).toContain('Waiting for the generator');

    const deletion = await request(app)
      .delete(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(409);
    expect(deletion.body.code).toBe('runtime_cancel_pending');

    await worker;
    const terminal = await request(app)
      .get(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(200);
    expect(terminal.body.status).toBe('cancelled');
  }, 15_000);

  it('rejects browser-supplied hydrated reference payloads', async () => {
    const { app } = await import('../../apps/api/src/index.js');
    const auth = { authorization: 'Bearer forged-reference-payload-user' };
    const response = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'forged-reference-payload-key')
      .send({
        prompt: 'A cinematic scene with a privately managed reference.',
        settings: {
          aspectRatio: '16:9',
          durationSeconds: 4,
          quality: 'draft',
          referenceConditioning: [{
            id: 'reference-forged-01',
            type: 'character',
            version: 1,
            imageBase64: 'data:image/png;base64,Zm9yZ2Vk',
            sceneIds: ['scene-1'],
          }],
        },
      })
      .expect(400);

    expect(response.body.code).toBe('invalid_reference_conditioning');
    expect(JSON.stringify(response.body)).not.toContain('Zm9yZ2Vk');
  });

  it('rejects another user\'s private reference during project persistence', async () => {
    const { app } = await import('../../apps/api/src/index.js');
    const ownerAuth = { authorization: 'Bearer reference-asset-owner' };
    const attackerAuth = { authorization: 'Bearer reference-project-attacker' };
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const upload = await request(app)
      .post('/v1/assets/upload-url')
      .set(ownerAuth)
      .send({ fileName: 'private-lead.png', contentType: 'image/png', sizeBytes: image.length, purpose: 'reference' })
      .expect(201);
    await request(app)
      .put(upload.body.uploadUrl)
      .set(ownerAuth)
      .set('content-type', 'image/png')
      .send(image)
      .expect(204);

    const response = await request(app)
      .post('/v1/storyboards/projects')
      .set(attackerAuth)
      .send({
        title: 'Cross-user reference attempt',
        form: {
          overallGoal: 'A scene that must not access another user\'s reference.',
          projectReferences: [{
            id: 'reference-stolen-01',
            type: 'character',
            label: 'Stolen reference',
            description: '',
            lockedTraits: [],
            sceneIds: [],
            assetId: upload.body.assetId,
            assetVersionIds: [upload.body.assetId],
            version: 1,
          }],
          scenes: [{
            id: 'scene-1',
            title: 'Private scene',
            prompt: 'The protected character enters frame.',
            duration: 4,
            trimStart: 0,
            trimEnd: 4,
            seed: 1337,
            seedOverrideEnabled: false,
            summary: '',
            continuityOverrides: {},
            transition: 'cut',
            transitionDuration: 0.75,
            carryPreviousFrame: false,
            referenceIds: ['reference-stolen-01'],
          }],
        },
      })
      .expect(403);

    expect(response.body.code).toBe('reference_forbidden');
    expect(JSON.stringify(response.body)).not.toContain(upload.body.assetId);
  });

  it('hydrates only canonical owner-scoped project references for the runtime', async () => {
    vi.stubEnv('VIDEO_RUNTIME_PROVIDER', 'sulphur-ltx');
    vi.stubEnv('VIDEO_RUNTIME_BASE_URL', 'http://runtime.test');
    vi.stubEnv('VIDEO_RUNTIME_PAYLOAD_MODE', 'deploy-studio');
    let runtimePayload: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({
        ok: true,
        ready: true,
        worker: 'longform-ltx-storyboard-studio',
        capabilities: {
          workflow_modes: ['text', 'start', 'start_end', 'multi_keyframe', 'reference'],
          reference_conditioning: 'supported',
        },
        advanced_video_controls: {
          start_frame_supported: true,
          end_frame_supported: true,
          reference_conditioning_supported: true,
          max_scene_reference_images: 6,
        },
      });
      if (url.endsWith('/jobs') && init?.method === 'POST') {
        runtimePayload = JSON.parse(String(init.body));
        return Response.json({ id: 'reference-runtime-job' }, { status: 202 });
      }
      if (url.endsWith('/jobs/reference-runtime-job/output')) {
        return new Response(new Uint8Array([
          0x00, 0x00, 0x00, 0x18,
          0x66, 0x74, 0x79, 0x70,
          0x69, 0x73, 0x6f, 0x6d,
        ]), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      }
      if (url.endsWith('/jobs/reference-runtime-job')) {
        return Response.json({
          id: 'reference-runtime-job',
          status: 'completed',
          progress: 100,
          quality_report: {
            version: 'generated-text-qc-v1', advisory: true, score: 100, recommendation: 'recommended',
            checks: [{ id: 'generated_text_policy', status: 'passed', confidence: 1 }],
          },
        });
      }
      return Response.json({ id: 'runtime-probe', status: 'running' });
    }));

    const { app, processOne } = await import('../../apps/api/src/index.js');
    const owner = 'reference-generation-owner';
    const auth = { authorization: `Bearer ${owner}` };
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const upload = await request(app)
      .post('/v1/assets/upload-url')
      .set(auth)
      .send({ fileName: 'lead.png', contentType: 'image/png', sizeBytes: image.length, purpose: 'reference' })
      .expect(201);
    await request(app)
      .put(upload.body.uploadUrl)
      .set(auth)
      .set('content-type', 'image/png')
      .send(image)
      .expect(204);
    const project = await request(app)
      .post('/v1/storyboards/projects')
      .set(auth)
      .send({
        title: 'Reference-conditioned project',
        form: {
          overallGoal: 'A recurring explorer crosses a rain-dark city.',
          negativePrompt: '', resolution: '1024x576', fps: 24, imageSteps: 4,
          guidanceScale: 1, startFrameStrength: 1, endFrameStrength: 0.9,
          enhancePrompt: false, postProcess: 'none', outputFormat: 'mp4',
          globalVisualAnchorEnabled: false, globalSeed: 1337, seedPolicy: 'global_locked',
          continuityBible: {
            characters: '', wardrobe: '', props: '', location: '', sceneGeometry: '',
            timeOfDay: '', lighting: '', palette: '', lens: '', cameraPosition: '',
            cameraMovement: '', visualStyle: '', audio: '',
          },
          audioPolicy: {
            mode: 'silent', dialogue: 'off', soundEffects: 'off', ambience: 'off',
            music: 'off', preserveSourceAudio: false,
          },
          candidateCount: 1,
          projectReferences: [{
            id: 'reference-lead-01', type: 'character', label: 'Lead', description: 'Explorer in a teal coat.',
            lockedTraits: ['teal coat'], sceneIds: [], assetId: upload.body.assetId,
            assetVersionIds: [upload.body.assetId], version: 1,
          }],
          scenes: [{
            id: 'scene-1', title: 'Arrival', prompt: 'The explorer enters the rain-dark city.',
            duration: 4, trimStart: 0, trimEnd: 4, seed: 1337, seedOverrideEnabled: false,
            summary: '', continuityOverrides: {}, transition: 'cut', transitionDuration: 0.75,
            carryPreviousFrame: false, referenceIds: ['reference-lead-01'],
          }],
        },
      })
      .expect(201);
    const submitted = await request(app)
      .post('/v1/generations')
      .set(auth)
      .set('Idempotency-Key', 'reference-generation-key')
      .send({
        prompt: 'A recurring explorer crosses a rain-dark city.',
        settings: {
          runtime: 'longform-ltx-storyboard-studio', aspectRatio: '16:9', durationSeconds: 4,
          quality: 'draft', projectId: project.body.id, operationScope: 'project',
          storyboard: [{
            id: 'scene-1', title: 'Arrival', prompt: 'The explorer enters the rain-dark city.',
            duration: 4, trimStart: 0, trimEnd: 4, seed: 1337, transition: 'cut',
            transitionDuration: 0.75, carryPreviousFrame: false,
            referenceIds: ['forged-reference-id'],
          }],
        },
      })
      .expect(201);
    expect(submitted.body.settings.storyboard[0].referenceIds).toEqual(['reference-lead-01']);
    expect(JSON.stringify(submitted.body)).not.toContain(upload.body.assetId);
    expect(JSON.stringify(submitted.body)).not.toContain(image.toString('base64'));

    await processOne('reference-generation-worker');
    expect(runtimePayload).toMatchObject({
      reference_conditioning: [{
        id: 'reference-lead-01', type: 'character', version: 1, scene_ids: ['scene-1'],
      }],
      storyboard: [{ id: 'scene-1', reference_ids: ['reference-lead-01'] }],
    });
    expect(String((runtimePayload?.reference_conditioning as Array<Record<string, unknown>>)[0].image_base64))
      .toMatch(/^data:image\/jpeg;base64,/);
    const completed = await request(app)
      .get(`/v1/generations/${submitted.body.id}`)
      .set(auth)
      .expect(200);
    expect(completed.body.status).toBe('completed');
    expect(JSON.stringify(completed.body)).not.toContain('image_base64');
    expect(JSON.stringify(completed.body)).not.toContain(upload.body.assetId);
  }, 20_000);

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
      if (url.endsWith('/output')) return new Response(new Uint8Array([
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d,
      ]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'X-Video-Duration-Seconds': '4' },
      });
      if (url.includes('/jobs/')) return Response.json({
        status: 'completed',
        progress: 1,
        quality_report: {
          version: 'generated-text-qc-v1', advisory: true, score: 100, recommendation: 'recommended',
          checks: [{ id: 'generated_text_policy', status: 'passed', confidence: 1 }],
        },
      });
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

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await processOne('assembly-old-worker');
    const waiting = await request(app).get(`/v1/generations/${assembly.body.id}`).set(auth).expect(200);
    expect(waiting.body).toMatchObject({
      status: 'queued',
      runtimeMessage: 'Runtime changed; preparing assembly recovery',
    });
    expect(waiting.body).not.toHaveProperty('assemblyRuntimeAttempt');
    expect(JSON.stringify(waiting.body)).not.toContain('assembly-old-worker');

    await new Promise((resolve) => setTimeout(resolve, 1_050));
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
    await new Promise((resolve) => setTimeout(resolve, 1_050));
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
