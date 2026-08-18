import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedInteger, RuntimeCapacityPendingError, RuntimeLeaseUnavailableError, SulphurLtxRuntimeAdapter } from "../../packages/runtime-adapter/src/index.js";

describe("bounded runtime configuration", () => {
  it.each([
    [undefined, 120_000],
    ["", 120_000],
    ["not-a-number", 120_000],
    ["0", 120_000],
    ["-1", 120_000],
    ["1000.5", 120_000],
    ["999", 120_000],
    ["1000", 1_000],
    ["900000", 900_000],
    ["900001", 120_000],
  ])("fails %s to a safe bounded value", (value, expected) => {
    expect(boundedInteger(value, 120_000, 1_000, 900_000)).toBe(expected);
  });
});

describe("SulphurLtxRuntimeAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the canonical Deploy Studio jobs route", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/jobs")) {
          return Response.json(
            { id: "job-1", status: "queued" },
            { status: 202 },
          );
        }
        return Response.json({ id: "job-1", status: "running" });
      }),
    );

    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "http://runtime.test",
      payloadMode: "deploy-studio",
    });

    const submission = await adapter.submitGeneration({
      prompt: "A cinematic runtime test prompt",
      settings: {
        aspectRatio: "16:9",
        durationSeconds: 4,
        quality: "draft",
      },
    });
    const status = await adapter.getGenerationStatus(submission.runtimeJobId);

    expect(submission.runtimeJobId).toBe("job-1");
    expect(status.state).toBe("generating");
    expect(calls[0].url).toBe("http://runtime.test/jobs");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      prompt: "A cinematic runtime test prompt",
      resolution: "1280x720",
      duration: 4,
      output_format: "mp4",
    });
    expect(calls[1].url).toBe("http://runtime.test/jobs/job-1");
  });

  it("replays an ambiguous paid submission once with the same idempotency key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (calls.length === 1) throw new TypeError("response connection lost");
        return Response.json({ id: "original-paid-job", status: "queued" }, { status: 202 });
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(
      adapter.submitGeneration({
        prompt: "A bounded historical scene",
        idempotencyKey: "project-1:scene-1:version-1",
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: 2,
          quality: "draft",
        },
      }),
    ).resolves.toEqual({ runtimeJobId: "original-paid-job" });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(calls[1].url);
    expect(calls[0].init?.body).toBe(calls[1].init?.body);
    expect(
      (calls[0].init?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe("project-1:scene-1:version-1");
    expect(
      (calls[1].init?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe("project-1:scene-1:version-1");
  });

  it("does not replay an ambiguous submission without an idempotency key", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("response connection lost");
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(
      adapter.submitGeneration({
        prompt: "A generation without a durable retry key",
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: 2,
          quality: "draft",
        },
      }),
    ).rejects.toThrow("response connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [503, "runtime_submission_uncertain"],
    [409, "idempotency_in_progress"],
  ])(
    "keeps gateway reconciliation code %s/%s in the durable queue",
    async (status, code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { code, message: "safe retry" },
            { status, headers: { "retry-after": "7" } },
          ),
        ),
      );
      const adapter = new SulphurLtxRuntimeAdapter({
        baseUrl: "https://api.intelligensi.test",
        payloadMode: "intelligensi-api",
        runtimeId: "longform-ltx-storyboard-studio",
      });

      const submission = adapter.submitGeneration({
        prompt: "An idempotent reconciliation test",
        idempotencyKey: "project-1:scene-1:version-1",
        settings: {
          runtime: "longform-ltx-storyboard-studio",
          aspectRatio: "16:9",
          durationSeconds: 2,
          quality: "draft",
        },
      });
      await expect(submission).rejects.toMatchObject({
        name: "RuntimeCapacityPendingError",
        retryAfterSeconds: 7,
      });
    },
  );

  it("prefers the gateway's safe terminal failure over stale queued text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "failed-job",
          status: "failed",
          state: "failed",
          message: "Queued",
          error: {
            code: "runtime_video_encoding_failed",
            title: "The runtime could not encode the generated video. Retry this scene; if it repeats, turn off generated sound and try again.",
            detail: "private upstream path must not be selected",
          },
        }),
      ),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(adapter.getGenerationStatus("failed-job")).resolves.toMatchObject({
      state: "failed",
      failureCode: "runtime_video_encoding_failed",
      message: "The runtime could not encode the generated video. Retry this scene; if it repeats, turn off generated sound and try again.",
    });
    const status = await adapter.getGenerationStatus("failed-job");
    expect(status.message).not.toContain("Queued");
    expect(status.message).not.toContain("private upstream");
  });

  it("reports bounded unwanted-text repair without exposing OCR details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({
        id: "text-repair-job",
        status: "running",
        progress: 82,
        stage: "repairing_generated_text",
        message: "tesseract /tmp/private-frame.png detected internal token data",
      })),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(adapter.getGenerationStatus("text-repair-job")).resolves.toMatchObject({
      state: "generating",
      stage: "repairing_generated_text",
      message: "Repairing unwanted text",
    });
  });

  it("preserves enforced non-advisory generated-text evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({
        id: "frame-with-enforced-text-check",
        status: "completed",
        progress: 100,
        quality_report: {
          version: "generated-text-qc-v1",
          advisory: false,
          score: 100,
          recommendation: "recommended",
          checks: [
            {
              id: "generated_text_policy",
              status: "passed",
              confidence: 0.85,
              detail: "No forbidden visible text was detected.",
            },
          ],
        },
      })),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(
      adapter.getGenerationStatus("frame-with-enforced-text-check"),
    ).resolves.toMatchObject({
      state: "completed",
      qualityAssessment: {
        version: "generated-text-qc-v1",
        advisory: false,
        score: 100,
        recommendation: "recommended",
        checks: [
          {
            id: "generated_text_policy",
            status: "passed",
            confidence: 0.85,
          },
        ],
      },
    });
  });

  it("never exposes upstream infrastructure details as creator progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "private-progress-job",
          status: "running",
          progress: 500,
          stage: "lambda_worker_10_0_0_4",
          message:
            "Loading ComfyUI from http://10.0.0.4:8188 with bearer secret-token",
          qualityAssessment: {
            version: "media-qc-v2",
            advisory: true,
            score: 50,
            recommendation: "review",
            checks: [
              {
                id: "container_path",
                status: "warning",
                confidence: 1,
                detail: "Inspect /workspace/private/job.json on Lambda",
              },
            ],
          },
        }),
      ),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    const status = await adapter.getGenerationStatus("private-progress-job");

    expect(status).toMatchObject({
      state: "generating",
      progress: 100,
      message: "Rendering generation",
    });
    expect(status.stage).toBeUndefined();
    expect(status.qualityAssessment?.checks[0]?.detail).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(
      /lambda|comfyui|10\.0\.0\.4|bearer|workspace|secret-token/i,
    );
  });

  it("replaces unsafe terminal errors and invalid codes with a fixed message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "private-failure-job",
          status: "failed",
          progress: "not-a-number",
          error: {
            code: "provider_lambda_secret_failure",
            title: "Docker failed at /workspace/private using token abc123",
          },
        }),
      ),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(
      adapter.getGenerationStatus("private-failure-job"),
    ).resolves.toEqual({
      state: "failed",
      progress: 0,
      message:
        "The runtime could not complete this generation. The previous successful version remains available.",
    });
  });

  it("keeps an in-flight cancellation non-terminal until the worker confirms it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "cancelling-job",
          status: "cancelling",
          stage: "cancelling",
          progress: 42,
          message: "Interrupting ComfyUI at http://127.0.0.1:8188",
        }),
      ),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(adapter.getGenerationStatus("cancelling-job")).resolves.toEqual({
      state: "generating",
      progress: 42,
      message: "Cancelling generation",
      stage: "cancelling",
    });
  });

  it("distinguishes accepted cancellation from confirmed termination", async () => {
    const responses = [
      Response.json(
        { status: "running", state: "generating", stage: "cancelling" },
        { status: 200 },
      ),
      Response.json({ status: "cancelled" }, { status: 202 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });

    await expect(adapter.cancelGeneration("running-job")).resolves.toEqual({
      cancelled: false,
      accepted: true,
    });
    await expect(adapter.cancelGeneration("stopped-job")).resolves.toEqual({
      cancelled: true,
      accepted: true,
    });
  });

  it("uses the baked Sulphur prompt completion endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("http://runtime.test/prompt/complete");
        expect(JSON.parse(String(init?.body))).toEqual({
          prompt: "A fox crosses a wet road",
          mode: "expand",
        });
        return Response.json({
          completedPrompt: "A fox is crossing a rain-dark road.",
          mode: "expand",
          provider: "sulphur-gemma",
        });
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "http://runtime.test",
      payloadMode: "deploy-studio",
    });

    await expect(
      adapter.completePrompt("A fox crosses a wet road"),
    ).resolves.toMatchObject({
      completedPrompt: "A fox is crossing a rain-dark road.",
      provider: "sulphur-gemma",
    });
  });

  it("detects LongForm and maps a complete storyboard payload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const requestUrl = String(url);
        calls.push({ url: requestUrl, init });
        if (requestUrl.includes("/v1/runtimes?")) {
          return Response.json({
            runtimes: [
              {
                runtimeId: "longform-ltx-storyboard-studio",
                status: "ready",
                ready: true,
              },
            ],
          });
        }
        if (requestUrl.endsWith("/health")) {
          return Response.json({
            ok: true,
            ready: true,
            worker: "longform-ltx-storyboard-studio",
            capabilities: {
              workflow_modes: ["text", "start", "start_end", "multi_keyframe", "reference"],
              default_video_model: "ltx-2.5",
              video_models: [
                { id: "ltx-2.3", label: "LTX 2.3", status: "proven", available: false, recommended: false, workflow_modes: [] },
                { id: "ltx-2.5", label: "LTX 2.5", status: "preview", available: true, recommended: true, workflow_modes: ["text", "start"] },
              ],
              reference_conditioning: "supported",
              project_reference_planning: "director_and_runtime",
            },
            advanced_video_controls: {
              start_frame_supported: true,
              end_frame_supported: true,
              intermediate_keyframes_supported: true,
              max_intermediate_keyframes: 6,
              reference_conditioning_supported: true,
              max_scene_reference_images: 6,
            },
          });
        }
        return Response.json(
          { id: "storyboard-job", status: "queued" },
          { status: 202 },
        );
      }),
    );

    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "http://runtime.test",
      payloadMode: "deploy-studio",
    });
    const health = await adapter.healthCheck();
    await adapter.submitGeneration({
      prompt: "A continuous cinematic story",
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        videoModel: "ltx-2.5",
        aspectRatio: "16:9",
        durationSeconds: 8,
        quality: "standard",
        resolution: "1024x576",
        fps: 24,
        overallGoal: "Keep the monolith visually consistent",
        negativePrompt: "flicker",
        generatedTextPolicy: {
          mode: "forbidden", captions: false, subtitles: false, closedCaptions: false,
          titleCards: false, textOverlays: false, logos: false, watermarks: false,
          signage: "avoid_readable_text",
        },
        referenceConditioning: [{
          id: "reference-monolith",
          type: "product",
          version: 2,
          imageBase64: "data:image/jpeg;base64,cmVmZXJlbmNl",
          sceneIds: ["scene-1"],
        }],
        storyboard: [
          {
            id: "scene-1",
            title: "Reveal",
            prompt: "The glass monolith rises through the dawn mist",
            duration: 8,
            trimStart: 0,
            trimEnd: 7.5,
            seed: 1337,
            transition: "cut",
            transitionDuration: 0.75,
            carryPreviousFrame: true,
            referenceIds: ["reference-monolith"],
            generatedTextIntent: { mode: "none", visibleText: [], reason: "No visible text requested." },
            seedOverride: true,
            summary: "The monolith is fully visible above the mist.",
            continuityOverrides: { lighting: "Warm dawn rim light" },
            keyframes: [{
              id: "mid-reveal",
              timeSeconds: 3.5,
              strength: 0.9,
              temporalKeyframeBase64: "data:image/png;base64,a2V5ZnJhbWU=",
            }],
          },
        ],
      },
    });

    expect(health.provider).toBe("longform-ltx-storyboard-studio");
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      video_model: "ltx-2.5",
      overall_goal: "Keep the monolith visually consistent",
      negative_prompt: "flicker",
      generated_text_policy: {
        mode: "forbidden", captions: false, subtitles: false, closedCaptions: false,
        titleCards: false, textOverlays: false, logos: false, watermarks: false,
        signage: "avoid_readable_text",
      },
      resolution: "1024x576",
      reference_conditioning: [{
        id: "reference-monolith",
        type: "product",
        version: 2,
        image_base64: "data:image/jpeg;base64,cmVmZXJlbmNl",
        scene_ids: ["scene-1"],
      }],
      storyboard: [
        {
          id: "scene-1",
          title: "Reveal",
          duration: 8,
          trim_start: 0,
          trim_end: 7.5,
          seed: 1337,
          transition: "cut",
          carry_previous_frame: true,
          reference_ids: ["reference-monolith"],
          generated_text_intent: { mode: "none", visibleText: [], reason: "No visible text requested." },
          seed_override: true,
          summary: "The monolith is fully visible above the mist.",
          continuity_overrides: { lighting: "Warm dawn rim light" },
          keyframes: [{
            id: "mid-reveal",
            time_seconds: 3.5,
            strength: 0.9,
            image_base64: "data:image/png;base64,a2V5ZnJhbWU=",
          }],
        },
      ],
    });
    expect(health.capabilities).toMatchObject({
      defaultVideoModel: "ltx-2.5",
      videoModels: [
        { id: "ltx-2.3", available: false, status: "proven" },
        { id: "ltx-2.5", available: true, status: "preview", workflowModes: ["text", "start"] },
      ],
      intermediateKeyframes: true,
      maxIntermediateKeyframes: 6,
      referenceConditioning: true,
      maxSceneReferenceImages: 6,
      workflowModes: ["text", "start", "start_end", "multi_keyframe", "reference"],
      featureStatus: {
        referencePlanning: "supported",
        referenceConditioning: "supported",
      },
    });
  });

  it("wraps a Sulphur request as one scene for a LongForm worker", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return url.endsWith("/health")
          ? Response.json({
              ok: true,
              ready: true,
              worker: "longform-ltx-storyboard-studio",
            })
          : Response.json({ id: "single-scene-job" }, { status: 202 });
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "http://runtime.test",
      payloadMode: "deploy-studio",
    });

    await adapter.healthCheck();
    await adapter.submitGeneration({
      prompt: "A monolith rises above the ocean",
      settings: {
        aspectRatio: "16:9",
        durationSeconds: 4,
        quality: "draft",
        seed: 42,
      },
    });

    const payload = JSON.parse(String(calls[1].init?.body));
    expect(payload.storyboard).toHaveLength(1);
    expect(payload.storyboard[0]).toMatchObject({
      prompt: "A monolith rises above the ocean",
      duration: 4,
      seed: 42,
    });
  });

  it("downloads the completed runtime artifact", async () => {
    const mp4 = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://runtime.test/jobs/job-with-video/output");
        return new Response(mp4, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "x-video-duration-seconds": "4",
          },
        });
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "http://runtime.test",
      payloadMode: "deploy-studio",
    });

    const output = await adapter.fetchOutput("job-with-video");

    expect(output.contentType).toBe("video/mp4");
    expect(output.durationSeconds).toBe(4);
    expect(output.bytes).toEqual(mp4);
  });

  it("maps an independent first-frame operation and accepts a PNG artifact", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/jobs"))
          return Response.json({ id: "frame-job" }, { status: 202 });
        return new Response(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          {
            headers: { "content-type": "image/png" },
          },
        );
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://runtime.test",
      payloadMode: "deploy-studio",
    });
    await adapter.submitGeneration({
      prompt: "A cinematic opening frame for a connected story",
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: "16:9",
        durationSeconds: 5,
        quality: "draft",
        operationScope: "start_frame",
        operationSceneId: "scene-1",
        framePrompt:
          "A wide opening composition in cool rain and reflected teal light.",
        storyboard: [
          {
            id: "scene-1",
            title: "Opening",
            prompt: "A founder crosses the wet street.",
            duration: 5,
            trimStart: 0,
            trimEnd: 5,
            seed: 1337,
            transition: "cut",
            transitionDuration: 0.75,
            carryPreviousFrame: true,
          },
        ],
      },
    });
    const payload = JSON.parse(String(calls[0].init?.body));
    expect(payload).toMatchObject({
      operation_scope: "start_frame",
      operation_scene_id: "scene-1",
      frame_prompt:
        "A wide opening composition in cool rain and reflected teal light.",
    });
    await expect(adapter.fetchOutput("frame-job")).resolves.toMatchObject({
      contentType: "image/png",
    });
  });

  it("maps private assembly job ids and a stable runtime idempotency key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ id: "assembly-job" }, { status: 202 });
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://runtime.test",
      payloadMode: "deploy-studio",
    });
    await adapter.submitGeneration({
      prompt: "Assemble two accepted clips",
      idempotencyKey: "video-lab:generation-123",
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: "16:9",
        durationSeconds: 8,
        quality: "draft",
        operationScope: "assembly",
        assemblyJobIds: ["runtime-scene-1", "runtime-scene-2"],
        storyboard: [1, 2].map((number) => ({
          id: `scene-${number}`,
          title: `Scene ${number}`,
          prompt: `Scene direction ${number}`,
          duration: 4,
          trimStart: 0,
          trimEnd: 4,
          seed: 1337,
          transition: "cut",
          transitionDuration: 0.75,
          carryPreviousFrame: number > 1,
        })),
      },
    });
    expect(calls[0].init?.headers).toMatchObject({
      "Idempotency-Key": "video-lab:generation-123",
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      operation_scope: "assembly",
      assembly_job_ids: ["runtime-scene-1", "runtime-scene-2"],
    });
  });

  it("maps verified portable assembly artifacts without exposing storage to the browser", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ id: "portable-assembly-job" }, { status: 202 });
    }));
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });
    await adapter.submitGeneration({
      prompt: "Assemble portable accepted clips",
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: "16:9",
        durationSeconds: 8,
        quality: "draft",
        operationScope: "assembly",
        assemblySources: [{
          url: "https://storage.googleapis.com/private-signed-object",
          contentType: "video/mp4",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
        }],
        storyboard: [{
          id: "scene-1",
          title: "Scene 1",
          prompt: "Scene direction",
          duration: 4,
          trimStart: 0,
          trimEnd: 4,
          seed: 1337,
          transition: "cut",
          transitionDuration: 0.75,
          carryPreviousFrame: false,
        }],
      },
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      assembly_sources: [{
        url: "https://storage.googleapis.com/private-signed-object",
        content_type: "video/mp4",
        size_bytes: 1024,
        sha256: "a".repeat(64),
      }],
    });
  });

  it("reports managed demand and classifies temporary pool exhaustion", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/capacity-demand")) return Response.json({ accepted: true, observedAt: new Date().toISOString() }, { status: 202 });
      return Response.json({ code: "runtime_capacity_pending" }, { status: 429, headers: { "Retry-After": "17" } });
    }));
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });
    await expect(adapter.reportCapacityDemand(3, 75)).resolves.toBeUndefined();
    await expect(adapter.submitGeneration({
      prompt: "Wait safely for capacity",
      settings: { aspectRatio: "16:9", durationSeconds: 4, quality: "draft" },
    })).rejects.toMatchObject<Partial<RuntimeCapacityPendingError>>({
      name: "RuntimeCapacityPendingError",
      retryAfterSeconds: 17,
    });
    expect(calls[0]).toContain("/capacity-demand");
  });

  it("classifies a lost runtime lease without exposing the upstream response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      code: "runtime_unavailable",
      detail: "private provider address and internal diagnostics",
    }, { status: 503, headers: { "Retry-After": "11" } })));
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.test",
      payloadMode: "intelligensi-api",
      runtimeId: "longform-ltx-storyboard-studio",
    });
    const error = await adapter.getGenerationStatus("lost-worker-job").catch((caught) => caught);
    expect(error).toMatchObject<Partial<RuntimeLeaseUnavailableError>>({
      name: "RuntimeLeaseUnavailableError",
      message: "runtime_lease_unavailable",
      retryAfterSeconds: 11,
    });
    expect(String(error)).not.toContain("private provider address");
  });

  it("projects only safe LongForm capability metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          ready: true,
          worker: "longform-ltx-storyboard-studio",
          capabilities: {
            workflow_modes: ["text", "start", "start_end", "multi_keyframe"],
            style_reference: "not_supported_by_this_runtime",
            subject_reference: "not_supported_by_this_runtime",
          },
          advanced_video_controls: {
            start_frame_supported: true,
            end_frame_supported: true,
            intermediate_keyframes_supported: true,
            max_intermediate_keyframes: 6,
          },
          storyboard: {
            max_scenes: 24,
            continuity: "actual_previous_clip_last_frame",
            post_process: ["none", "interpolate", "upscale", "both"],
          },
        }),
      ),
    );
    const health = await new SulphurLtxRuntimeAdapter({
      baseUrl: "https://runtime.test",
      payloadMode: "deploy-studio",
    }).healthCheck();
    expect(health.capabilities).toMatchObject({
      maxScenes: 24,
      previousFrameContinuity: true,
      sceneAssembly: true,
      audioPreservation: true,
      styleReference: false,
      subjectReference: false,
      intermediateKeyframes: true,
      maxIntermediateKeyframes: 6,
      featureStatus: { multipleKeyframes: "supported" },
    });
  });

  it("rejects a runtime-provided artifact URL on another origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/jobs/job-1/output"))
          return new Response("missing", { status: 404 });
        return Response.json({
          status: "completed",
          output_url: "http://169.254.169.254/latest/meta-data",
        });
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://runtime.test",
      payloadMode: "deploy-studio",
    });
    await expect(adapter.fetchOutput("job-1")).rejects.toThrow(
      "outside its configured origin",
    );
  });

  it("uses the versioned Intelligensi runtime API contract", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const requestUrl = String(url);
        calls.push({ url: requestUrl, init });
        if (requestUrl.includes("/v1/runtimes?")) {
          return Response.json({
            runtimes: [
              {
                runtimeId: "longform-ltx-storyboard-studio",
                status: "ready",
                ready: true,
              },
            ],
          });
        }
        if (requestUrl.endsWith("/health")) {
          return Response.json({
            runtimeId: "longform-ltx-storyboard-studio",
            status: "ready",
            ready: true,
            checkedAt: "2026-08-01T12:00:00.000Z",
            features: {
              maxScenes: 24,
              maxSceneDurationSeconds: 8,
              workflowModes: ["text", "start", "start_end"],
              operationScopes: [
                "project",
                "scene",
                "start_frame",
                "end_frame",
                "assembly",
              ],
              postProcess: ["none", "interpolate", "upscale", "both"],
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
        }
        if (requestUrl.endsWith("/prompt/complete")) {
          return Response.json({
            runtimeId: "longform-ltx-storyboard-studio",
            mode: "expand",
            completion: "A richer cinematic prompt.",
            model: "gemma-local",
          });
        }
        if (requestUrl.endsWith("/preview")) {
          return Response.json(
            {
              id: "gateway-job",
              runtimeId: "longform-ltx-storyboard-studio",
              status: "queued",
              progress: 0,
              createdAt: "2026-08-01T12:00:00.000Z",
              links: {
                self: "/v1/runtimes/longform-ltx-storyboard-studio/jobs/gateway-job",
                cancel:
                  "/v1/runtimes/longform-ltx-storyboard-studio/jobs/gateway-job/cancel",
                output: null,
              },
            },
            { status: 202 },
          );
        }
        return Response.json({
          id: "gateway-job",
          runtimeId: "longform-ltx-storyboard-studio",
          status: "running",
          progress: 0.55,
          framesRendered: 81,
          totalFrames: 192,
          currentScene: 2,
          totalScenes: 4,
          stage: "generating_scene",
          qualityAssessment: {
            version: "media-qc-v2",
            advisory: true,
            score: 90,
            recommendation: "review",
            checks: [{ id: "black_frames", status: "warning", confidence: 0.95 }],
          },
          createdAt: "2026-08-01T12:00:00.000Z",
          links: {
            self: "/v1/runtimes/longform-ltx-storyboard-studio/jobs/gateway-job",
            cancel:
              "/v1/runtimes/longform-ltx-storyboard-studio/jobs/gateway-job/cancel",
            output: null,
          },
        });
      }),
    );
    const adapter = new SulphurLtxRuntimeAdapter({
      baseUrl: "https://api.intelligensi.ai",
      token: "server-only-key",
      runtimeId: "longform-ltx-storyboard-studio",
      payloadMode: "intelligensi-api",
    });

    const discovered = await adapter.discoverReadyRuntime();
    const health = await adapter.healthCheck();
    const completion = await adapter.completePrompt("A simple idea");
    const submission = await adapter.submitGeneration({
      prompt: "A simple idea",
      settings: {
        runtime: "longform-ltx-storyboard-studio",
        aspectRatio: "16:9",
        durationSeconds: 4,
        quality: "draft",
      },
    });
    const status = await adapter.getGenerationStatus(submission.runtimeJobId);

    expect(discovered).toMatchObject({
      runtimeId: "longform-ltx-storyboard-studio",
      status: "ready",
      ready: true,
    });
    expect(health).toMatchObject({
      ok: true,
      provider: "longform-ltx-storyboard-studio",
      capabilities: { maxScenes: 24, styleReference: false },
    });
    expect(completion).toMatchObject({
      completedPrompt: "A richer cinematic prompt.",
      provider: "longform-ltx-storyboard-studio",
    });
    expect(status).toMatchObject({
      state: "generating",
      progress: 55,
      framesRendered: 81,
      totalFrames: 192,
      currentScene: 2,
      totalScenes: 4,
      stage: "generating_scene",
      qualityAssessment: {
        version: "media-qc-v2",
        advisory: true,
        score: 90,
        recommendation: "review",
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.intelligensi.ai/v1/runtimes?capability=storyboard-enhance&ready=true",
      "https://api.intelligensi.ai/v1/runtimes/longform-ltx-storyboard-studio/health",
      "https://api.intelligensi.ai/v1/runtimes/longform-ltx-storyboard-studio/prompt/complete",
      "https://api.intelligensi.ai/v1/runtimes/longform-ltx-storyboard-studio/preview",
      "https://api.intelligensi.ai/v1/runtimes/longform-ltx-storyboard-studio/jobs/gateway-job",
    ]);
    for (const call of calls) {
      expect(call.init?.headers).toMatchObject({
        "X-Intelligensi-API-Key": "server-only-key",
      });
      expect(
        (call.init?.headers as Record<string, string>).authorization,
      ).toBeUndefined();
    }
  });
});
