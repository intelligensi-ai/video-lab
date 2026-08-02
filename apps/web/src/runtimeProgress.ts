import type { Generation } from "@video-lab/contracts";

export function runtimeProgressCounter(generation?: Generation) {
  if (
    typeof generation?.runtimeProgress?.framesRendered === "number" &&
    typeof generation.runtimeProgress.totalFrames === "number" &&
    generation.runtimeProgress.totalFrames > 0
  ) {
    return `Frame ${generation.runtimeProgress.framesRendered.toLocaleString()} / ${generation.runtimeProgress.totalFrames.toLocaleString()}`;
  }
  if (
    typeof generation?.runtimeProgress?.currentScene === "number" &&
    typeof generation.runtimeProgress.totalScenes === "number" &&
    generation.runtimeProgress.totalScenes > 0
  ) {
    return `Scene ${generation.runtimeProgress.currentScene.toLocaleString()} / ${generation.runtimeProgress.totalScenes.toLocaleString()}`;
  }
  return undefined;
}
