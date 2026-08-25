import { describe, expect, it } from "vitest";
import {
  defaultLongFormVideoModelForRuntime,
  fallbackLongFormVideoModels,
  longFormVideoModelAvailable,
  longFormVideoModelLabel,
  longFormVideoModelsForRuntime,
  longFormProjectHasRenderedVideo,
  normalizeLongFormVideoModel,
  prepareLongFormVideoModelSwitch,
} from "../../apps/web/src/longFormVideoModels.js";
import type { LongFormGenerationPayload } from "../../apps/web/src/api.js";

describe("LongForm video model catalogue", () => {
  it("keeps LTX 2.3 available while LTX 2.5 awaits an accepted runtime", () => {
    expect(fallbackLongFormVideoModels).toEqual([
      expect.objectContaining({ id: "ltx-2.3", available: true, status: "proven" }),
      expect.objectContaining({ id: "ltx-2.5", available: false, status: "unavailable" }),
    ]);
  });

  it("uses the managed runtime catalogue when it is advertised", () => {
    const videoModels = [
      {
        id: "ltx-2.5" as const,
        label: "LTX 2.5",
        status: "preview" as const,
        available: true,
        recommended: false,
        workflowModes: ["text", "start"],
      },
    ];
    const runtime = {
      status: "ready" as const,
      capabilities: { videoModels },
    };

    expect(longFormVideoModelsForRuntime(runtime)).toBe(videoModels);
    expect(longFormVideoModelLabel(videoModels[0])).toBe("LTX 2.5 - Preview");
    expect(defaultLongFormVideoModelForRuntime(runtime)).toBe("ltx-2.5");
    expect(longFormVideoModelAvailable(runtime, "ltx-2.3")).toBe(false);
  });

  it("normalizes legacy and unexpected values to the proven LTX 2.3 path", () => {
    expect(normalizeLongFormVideoModel("ltx-2.5")).toBe("ltx-2.5");
    expect(normalizeLongFormVideoModel(undefined)).toBe("ltx-2.3");
    expect(normalizeLongFormVideoModel("arbitrary-model")).toBe("ltx-2.3");
  });

  it("detects accepted and unaccepted rendered video before changing model", () => {
    expect(longFormProjectHasRenderedVideo({ scenes: [{ id: "scene-1" }] } as LongFormGenerationPayload)).toBe(false);
    expect(longFormProjectHasRenderedVideo({
      scenes: [{ id: "scene-1", candidateGenerationIds: ["generation-draft"] }],
    } as LongFormGenerationPayload)).toBe(true);
    expect(longFormProjectHasRenderedVideo({
      scenes: [{ id: "scene-1", acceptedVideoGenerationId: "generation-accepted" }],
    } as LongFormGenerationPayload)).toBe(true);
  });

  it("preserves creative inputs but removes every old-model video from the new project copy", () => {
    const form = {
      videoModel: "ltx-2.3",
      scenes: [
        {
          id: "scene-1",
          prompt: "Accepted",
          acceptedVideoGenerationId: "generation-1",
          candidateGenerationIds: ["generation-1", "generation-2"],
          staleReason: "Old prompt",
          startFrameGenerationId: "frame-1",
        },
        { id: "scene-2", prompt: "Draft", candidateGenerationIds: ["generation-3"] },
        { id: "scene-3", prompt: "Not rendered" },
      ],
    } as LongFormGenerationPayload;

    const switched = prepareLongFormVideoModelSwitch(form, "ltx-2.5");

    expect(switched).not.toBe(form);
    expect(switched.videoModel).toBe("ltx-2.5");
    expect(switched.scenes[0]).toEqual({
      id: "scene-1",
      prompt: "Accepted",
      startFrameGenerationId: "frame-1",
    });
    expect(switched.scenes[1]).toEqual({ id: "scene-2", prompt: "Draft" });
    expect(switched.scenes[2]).toBe(form.scenes[2]);
    expect(form.videoModel).toBe("ltx-2.3");
    expect(form.scenes[0].acceptedVideoGenerationId).toBe("generation-1");
    expect(form.scenes[0].candidateGenerationIds).toEqual(["generation-1", "generation-2"]);
  });
});
