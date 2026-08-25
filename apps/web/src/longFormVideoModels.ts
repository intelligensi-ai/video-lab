import type {
  LongFormVideoModel,
  LongFormVideoModelCapability,
  RuntimeStatus,
} from "@video-lab/contracts";
import type { LongFormGenerationPayload } from "./api.js";

export const fallbackLongFormVideoModels: LongFormVideoModelCapability[] = [
  {
    id: "ltx-2.3",
    label: "LTX 2.3",
    status: "proven",
    available: true,
    recommended: true,
    workflowModes: ["text", "start", "start_end", "multi_keyframe"],
  },
  {
    id: "ltx-2.5",
    label: "LTX 2.5",
    status: "unavailable",
    available: false,
    recommended: false,
    workflowModes: [],
    reason: "Awaiting an approved LTX 2.5 managed runtime.",
  },
];

export function longFormVideoModelsForRuntime(runtime?: RuntimeStatus) {
  return runtime?.capabilities?.videoModels?.length
    ? runtime.capabilities.videoModels
    : fallbackLongFormVideoModels;
}

export function defaultLongFormVideoModelForRuntime(runtime?: RuntimeStatus): LongFormVideoModel {
  const models = longFormVideoModelsForRuntime(runtime);
  const runtimeDefault = runtime?.capabilities?.defaultVideoModel;
  if (runtimeDefault && models.some((model) => model.id === runtimeDefault && model.available)) {
    return runtimeDefault;
  }
  return models.find((model) => model.recommended && model.available)?.id ??
    models.find((model) => model.available)?.id ??
    "ltx-2.3";
}

export function longFormVideoModelAvailable(runtime: RuntimeStatus | undefined, videoModel: LongFormVideoModel) {
  return longFormVideoModelsForRuntime(runtime).some(
    (model) => model.id === videoModel && model.available,
  );
}

export function longFormVideoModelLabel(model: LongFormVideoModelCapability) {
  const status = model.status === "proven"
    ? "Proven"
    : model.status === "preview"
      ? "Preview"
      : "Unavailable";
  return `${model.label} - ${status}`;
}

export function normalizeLongFormVideoModel(value: unknown): LongFormVideoModel {
  return value === "ltx-2.5" ? "ltx-2.5" : "ltx-2.3";
}

export function longFormProjectHasRenderedVideo(form: LongFormGenerationPayload) {
  return form.scenes.some(
    (scene) => Boolean(scene.acceptedVideoGenerationId) || Boolean(scene.candidateGenerationIds?.length),
  );
}

export function prepareLongFormVideoModelSwitch(
  form: LongFormGenerationPayload,
  videoModel: LongFormVideoModel,
): LongFormGenerationPayload {
  return {
    ...form,
    videoModel,
    scenes: form.scenes.map((scene) => {
      if (!scene.acceptedVideoGenerationId && !scene.candidateGenerationIds?.length) return scene;
      const {
        acceptedVideoGenerationId: _acceptedVideoGenerationId,
        candidateGenerationIds: _candidateGenerationIds,
        staleReason: _staleReason,
        ...preservedScene
      } = scene;
      return preservedScene;
    }),
  };
}
