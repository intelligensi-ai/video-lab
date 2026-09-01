import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultGeneratedTextPolicy } from "@video-lab/contracts";
import {
  acceptedGenerationRequiresConfirmation,
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
  it("requires confirmation only before replacing a downloadable completed film", () => {
    expect(
      acceptedGenerationRequiresConfirmation({
        status: "completed",
        output: { downloadUrl: "/v1/media/video-accepted" },
      }),
    ).toBe(true);
    expect(
      acceptedGenerationRequiresConfirmation({
        status: "completed",
        output: {},
      }),
    ).toBe(false);
    expect(
      acceptedGenerationRequiresConfirmation({
        status: "failed",
        output: { downloadUrl: "/v1/media/video-accepted" },
      }),
    ).toBe(false);
    expect(acceptedGenerationRequiresConfirmation()).toBe(false);
  });

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

  it("submits the Creator master prompt as a single-scene storyboard", () => {
    const original = projectForm();
    original.videoModel = "ltx-2.5";
    const restored = formForStudioVariant(original, true);
    restored.scenes[0].prompt = "Legacy scene prompt that should not drive Creator mode.";
    const submitted = generationPayloadForStudioVariant(restored, true);

    // Creator keeps only the first scene, even from a legacy multi-scene project.
    expect(restored.scenes.map((item) => item.id)).toEqual(["scene-1"]);
    expect(submitted.scenes.map((item) => item.id)).toEqual(["scene-1"]);
    expect(original.scenes).toHaveLength(2);
    expect(submitted).toEqual({
      ...restored,
      scenes: restored.scenes.map((scene, index) => ({
        ...scene,
        prompt: index === 0 ? restored.overallGoal : scene.prompt,
        generatedTextIntent: {
          mode: "none",
          visibleText: [],
          reason:
            "Visible generated text is disabled for the Creator launch workflow.",
        },
      })),
      generatedTextPolicy: defaultGeneratedTextPolicy(),
    });
    expect(restored.videoModel).toBe("ltx-2.3");
    expect(submitted.videoModel).toBe("ltx-2.3");
  });

  it("normalises the generated-text policy for the advanced payload while leaving everything else intact", () => {
    const original = projectForm();
    original.videoModel = "ltx-2.5";
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

  it("preserves the Creator generated-text toggle in the submitted payload", () => {
    const original = projectForm();
    original.generatedTextPolicy = {
      ...defaultGeneratedTextPolicy(),
      mode: "allowed",
      signage: "allowed",
    };
    original.scenes[0].generatedTextIntent = {
      mode: "environmental",
      visibleText: ["OPEN"],
      reason: "The project text lock was switched off.",
    };

    const submitted = generationPayloadForStudioVariant(original, true);

    expect(submitted.generatedTextPolicy).toEqual(original.generatedTextPolicy);
    expect(submitted.scenes[0].generatedTextIntent).toEqual(
      original.scenes[0].generatedTextIntent,
    );
  });

  it("forces scene text intent off when the Creator no-text toggle is enabled", () => {
    const original = projectForm();
    original.generatedTextPolicy = defaultGeneratedTextPolicy();
    original.scenes[0].generatedTextIntent = {
      mode: "environmental",
      visibleText: ["OPEN"],
      reason: "Legacy scene text request.",
    };

    const submitted = generationPayloadForStudioVariant(original, true);

    expect(submitted.generatedTextPolicy).toEqual(defaultGeneratedTextPolicy());
    expect(submitted.scenes[0].generatedTextIntent).toEqual({
      mode: "none",
      visibleText: [],
      reason:
        "Visible generated text is disabled for the Creator launch workflow.",
    });
  });

  it("keeps Creator a single scene and clamps the length to 8 seconds", () => {
    const original = [scene("scene-1", 5)];
    const planned = creatorScenesForTotalDuration(original, 17, 4000);

    expect(planned).toHaveLength(1);
    expect(planned[0].duration).toBe(8);
    expect(planned[0].trimEnd).toBe(8);
    // the existing scene is preserved, not regenerated
    expect(planned[0].seed).toBe(1337);
  });

  it.each([1, 4, 8, 9, 16, 24])(
    "plans %i requested seconds as one Creator scene capped at 8s",
    (requestedSeconds) => {
      const planned = creatorScenesForTotalDuration(
        [scene("scene-1", 5)],
        requestedSeconds,
        7000,
      );

      expect(planned).toHaveLength(1);
      expect(planned[0].duration).toBe(Math.min(requestedSeconds, 8));
      expect(planned[0].duration).toBeGreaterThanOrEqual(1);
      expect(planned[0].duration).toBeLessThanOrEqual(8);
    },
  );

  it("caps Creator at one 8s scene even when more scenes are requested", () => {
    const planned = creatorScenesForTotalDuration(
      [scene("scene-1", 5)],
      24,
      9000,
      2,
    );

    expect(planned.map((item) => item.duration)).toEqual([8]);
  });

  it("resizes scenes even when they already have accepted media, since the change only affects the next render", () => {
    const acceptedScene = {
      ...scene("scene-1", 5),
      startFrameGenerationId: "frame-accepted",
      acceptedVideoGenerationId: "video-accepted",
    };
    const original = [acceptedScene, scene("scene-2", 4)];

    const shortened = creatorScenesForTotalDuration(original, 4, 1337);
    expect(shortened.map((item) => item.duration)).toEqual([4]);
    expect(shortened[0].acceptedVideoGenerationId).toBe("video-accepted");
  });
});
