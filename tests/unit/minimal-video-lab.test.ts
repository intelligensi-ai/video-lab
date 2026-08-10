import { describe, expect, it } from "vitest";
import {
  formForStudioVariant,
  generationPayloadForStudioVariant,
} from "../../apps/web/src/LongFormStoryboardStudio.js";
import {
  emptyContinuityBible,
  type LongFormGenerationPayload,
  type StoryboardScenePayload,
} from "../../apps/web/src/api.js";

function scene(id: string, duration: number): StoryboardScenePayload {
  return {
    id,
    title: id,
    prompt: `Direction for ${id}`,
    duration,
    trimStart: 0,
    trimEnd: duration,
    seed: 1337,
    seedOverrideEnabled: false,
    summary: "",
    continuityOverrides: {},
    transition: "cut",
    transitionDuration: 0.75,
    carryPreviousFrame: true,
  };
}

function projectForm(): LongFormGenerationPayload {
  return {
    overallGoal: "A two-scene film that must survive the minimal editor.",
    negativePrompt: "",
    resolution: "1280x720",
    fps: 24,
    imageSteps: 4,
    guidanceScale: 1,
    startFrameStrength: 1,
    endFrameStrength: 0.85,
    enhancePrompt: true,
    postProcess: "none",
    outputFormat: "mp4",
    globalSeed: 1337,
    seedPolicy: "global_locked",
    globalVisualAnchorEnabled: false,
    scenes: [scene("scene-1", 5), scene("scene-2", 7)],
    continuityBible: emptyContinuityBible(),
    audioPolicy: {
      mode: "intent_only",
      dialogue: "prompted_only",
      soundEffects: "intent_only",
      ambience: "intent_only",
      music: "prompted_or_unambiguous_performance",
      preserveSourceAudio: false,
    },
    candidateCount: 3,
    projectReferences: [],
  };
}

describe("minimal VideoLab project safety", () => {
  it("preserves hidden advanced scenes while submitting only the visible clip", () => {
    const original = projectForm();
    const restored = formForStudioVariant(original, true);
    const submitted = generationPayloadForStudioVariant(restored, true);

    expect(restored.scenes.map((item) => item.id)).toEqual([
      "scene-1",
      "scene-2",
    ]);
    expect(submitted.scenes.map((item) => item.id)).toEqual(["scene-1"]);
    expect(original.scenes).toHaveLength(2);
    expect(submitted).not.toBe(restored);
  });

  it("leaves the advanced generation payload intact", () => {
    const original = projectForm();
    expect(generationPayloadForStudioVariant(original, false)).toBe(original);
  });
});
