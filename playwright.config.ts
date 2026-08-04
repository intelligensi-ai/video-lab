import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

const outputDir =
  process.env.VIDEO_LAB_E2E_OUTPUT_DIR ??
  (process.platform === "win32"
    ? "E:\\tmp\\intelligensi-video-lab-audit\\playwright"
    : path.join(tmpdir(), "intelligensi-video-lab-audit", "playwright"));
const externalServers = process.env.VIDEO_LAB_E2E_EXTERNAL_SERVERS === "true";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir,
  webServer: externalServers ? undefined : [
    {
      command: "node node_modules/tsx/dist/cli.mjs apps/api/src/server.ts",
      url: "http://127.0.0.1:5001/v1/health",
      reuseExistingServer: true,
      env: {
        ...process.env,
        NODE_ENV: "development",
        VIDEO_LAB_LOCAL_AUTH: "true",
      },
    },
    {
      command: "node apps/web/node_modules/vite/bin/vite.js apps/web --host 0.0.0.0",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
    },
  ],
  use: { baseURL: "http://127.0.0.1:5173" },
});
