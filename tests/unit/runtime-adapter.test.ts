import { afterEach, describe, expect, it, vi } from "vitest";
import { SulphurLtxRuntimeAdapter } from "../../packages/runtime-adapter/src/index.js";

describe("SulphurLtxRuntimeAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Deploy Studio preview and job routes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/preview")) {
          return Response.json({ id: "job-1", status: "queued" }, { status: 202 });
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
    expect(calls[0].url).toBe("http://runtime.test/preview");
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

    await expect(adapter.completePrompt("A fox crosses a wet road")).resolves.toMatchObject({
      completedPrompt: "A fox is crossing a rain-dark road.",
      provider: "sulphur-gemma",
    });
  });

  it("detects LongForm and maps a complete storyboard payload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/health")) {
          return Response.json({
            ok: true,
            ready: true,
            worker: "longform-ltx-storyboard-studio",
          });
        }
        return Response.json({ id: "storyboard-job", status: "queued" }, { status: 202 });
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
});
