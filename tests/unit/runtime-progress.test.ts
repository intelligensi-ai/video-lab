import { describe, expect, it } from "vitest";
import type { Generation } from "@video-lab/contracts";
import { runtimeProgressCounter } from "../../apps/web/src/runtimeProgress.js";

function generation(runtimeProgress?: Generation["runtimeProgress"]): Generation {
  return {
    id: "generation-1",
    prompt: "A cinematic prompt",
    settings: { aspectRatio: "16:9", durationSeconds: 8, quality: "draft" },
    status: "generating",
    creditCost: 0,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    runtimeProgress,
  };
}

describe("runtime progress display", () => {
  it("shows real frame counters when the runtime reports them", () => {
    expect(
      runtimeProgressCounter(
        generation({ framesRendered: 81, totalFrames: 192 }),
      ),
    ).toBe("Frame 81 / 192");
  });

  it("falls back to scene counters for multi-scene jobs", () => {
    expect(
      runtimeProgressCounter(generation({ currentScene: 2, totalScenes: 4 })),
    ).toBe("Scene 2 / 4");
  });

  it("omits frame counts when the runtime does not report them", () => {
    expect(runtimeProgressCounter(generation())).toBeUndefined();
    expect(runtimeProgressCounter(generation({ stage: "generating" }))).toBeUndefined();
  });
});
