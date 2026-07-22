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
});
