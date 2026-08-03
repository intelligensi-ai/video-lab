import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

const outputDir =
  process.env.VIDEO_LAB_E2E_OUTPUT_DIR ??
  (process.platform === "win32"
    ? "E:\\tmp\\intelligensi-video-lab-audit\\playwright"
    : path.join(tmpdir(), "intelligensi-video-lab-audit", "playwright"));

export default defineConfig({
  testDir: "tests/e2e",
  outputDir,
  webServer: [
    {
      command: "pnpm --filter @video-lab/api dev",
      url: "http://127.0.0.1:5001/v1/health",
      reuseExistingServer: true,
      env: {
        ...process.env,
        NODE_ENV: "development",
        VIDEO_LAB_LOCAL_AUTH: "true",
      },
    },
    {
      command: "pnpm --filter @video-lab/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
    },
  ],
  use: { baseURL: "http://127.0.0.1:5173" },
});
