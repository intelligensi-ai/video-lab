import { afterEach, describe, expect, it, vi } from "vitest";
import { SulphurLtxRuntimeAdapter } from "../../packages/runtime-adapter/src/index.js";

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
        aspectRatio: "16:9",
        durationSeconds: 8,
        quality: "standard",
        resolution: "1024x576",
        fps: 24,
        overallGoal: "Keep the monolith visually consistent",
        negativePrompt: "flicker",
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
            seedOverride: true,
            summary: "The monolith is fully visible above the mist.",
            continuityOverrides: { lighting: "Warm dawn rim light" },
          },
        ],
      },
    });

    expect(health.provider).toBe("longform-ltx-storyboard-studio");
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      overall_goal: "Keep the monolith visually consistent",
      negative_prompt: "flicker",
      resolution: "1024x576",
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
          seed_override: true,
          summary: "The monolith is fully visible above the mist.",
          continuity_overrides: { lighting: "Warm dawn rim light" },
        },
      ],
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://runtime.test/jobs/job-with-video/output");
        return new Response(new Uint8Array([0, 0, 0, 24]), {
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
    expect(output.bytes).toEqual(new Uint8Array([0, 0, 0, 24]));
  });

  it("maps an independent first-frame operation and accepts a PNG artifact", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/jobs"))
          return Response.json({ id: "frame-job" }, { status: 202 });
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
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

  it("projects only safe LongForm capability metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          ready: true,
          worker: "longform-ltx-storyboard-studio",
          capabilities: {
            workflow_modes: ["text", "start", "start_end"],
            style_reference: "not_supported_by_this_runtime",
            subject_reference: "not_supported_by_this_runtime",
          },
          advanced_video_controls: {
            start_frame_supported: true,
            end_frame_supported: true,
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
