import { createRuntimeFromEnv } from "@video-lab/runtime-adapter";

const runtime = createRuntimeFromEnv();

const health = await runtime.healthCheck();
console.log("health", health);
if (!health.ok) {
  throw new Error(
    `Runtime health check failed: ${health.message ?? "unknown"}`,
  );
}

const submission = await runtime.submitGeneration({
  prompt:
    process.env.VIDEO_RUNTIME_SMOKE_PROMPT ??
    "A short cinematic smoke test of a glass monolith at sunrise",
  settings: {
    aspectRatio: "16:9",
    durationSeconds: 4,
    quality: "draft",
  },
});
console.log("submitted", submission);

const status = await runtime.getGenerationStatus(submission.runtimeJobId);
console.log("status", status);
