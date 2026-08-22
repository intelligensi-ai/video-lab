import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultGeneratedTextPolicy } from "@video-lab/contracts";
import {
  creatorScenesForTotalDuration,
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
  it("keeps the consolidated launch runbook linked and explicit about release evidence", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const runbook = readFileSync(
      new URL("../../docs/creator-minimal-launch-runbook-2026-08-17.md", import.meta.url),
      "utf8",
    );
    const normalizedRunbook = runbook.replace(/\s+/g, " ").toLowerCase();

    expect(readme).toContain("docs/creator-minimal-launch-runbook-2026-08-17.md");
    for (const requiredBoundary of [
      "## Architecture and trust boundaries",
      "## Minimal Creator input",
      "## Director output and authority",
      "## Semantic Director memory",
      "## LTX engine selection",
      "## Unwanted captions and generated text",
      "## Audio policy",
      "## Paid acceptance procedure",
      "## Known limitations and deferred work",
      "production promotion remains a separate explicit decision",
    ]) {
      expect(normalizedRunbook).toContain(requiredBoundary.toLowerCase());
    }
  });

  it("preserves and submits the Director's complete minimal storyboard", () => {
    const original = projectForm();
    const restored = formForStudioVariant(original, true);
    const submitted = generationPayloadForStudioVariant(restored, true);

    expect(restored.scenes.map((item) => item.id)).toEqual([
      "scene-1",
      "scene-2",
    ]);
    expect(submitted.scenes.map((item) => item.id)).toEqual([
      "scene-1",
      "scene-2",
    ]);
    expect(original.scenes).toHaveLength(2);
    expect(submitted).toEqual(restored);
  });

  it("normalises the generated-text policy for the advanced payload while leaving everything else intact", () => {
    const original = projectForm();
    const submitted = generationPayloadForStudioVariant(original, false);

    expect(submitted).toEqual({
      ...original,
      generatedTextPolicy: defaultGeneratedTextPolicy(),
      scenes: original.scenes.map((scene) => ({
        ...scene,
        generatedTextIntent: {
          mode: "none",
          visibleText: [],
          reason:
            "Visible generated text is disabled for the Creator launch workflow.",
        },
      })),
    });
  });

  it("turns an exact Creator length into the smallest balanced valid storyboard", () => {
    const original = [scene("scene-1", 5)];
    const planned = creatorScenesForTotalDuration(original, 17, 4000);

    expect(planned).toHaveLength(3);
    expect(planned.map((item) => item.duration)).toEqual([6, 6, 5]);
    expect(planned.reduce((total, item) => total + item.duration, 0)).toBe(17);
    expect(planned.every((item) => item.duration >= 1 && item.duration <= 8)).toBe(true);
    expect(planned.map((item) => item.seed)).toEqual([1337, 4001, 4002]);
  });

  it("respects the runtime scene limit and exact bounded duration", () => {
    const planned = creatorScenesForTotalDuration(
      [scene("scene-1", 5)],
      24,
      9000,
      2,
    );

    expect(planned.map((item) => item.duration)).toEqual([8, 8]);
    expect(planned.reduce((total, item) => total + item.duration, 0)).toBe(16);
  });

  it("does not remove or resize scenes that already contain successful media", () => {
    const protectedScene = {
      ...scene("scene-1", 5),
      startFrameGenerationId: "frame-accepted",
      acceptedVideoGenerationId: "video-accepted",
    };
    const original = [protectedScene, scene("scene-2", 4)];

    expect(creatorScenesForTotalDuration(original, 4, 1337)).toBe(original);
    expect(creatorScenesForTotalDuration(original, 12, 1337)).toBe(original);
  });
});
