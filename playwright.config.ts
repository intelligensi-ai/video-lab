import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

const outputDir =
  process.env.VIDEO_LAB_E2E_OUTPUT_DIR ??
  (process.platform === "win32"
    ? "E:\\tmp\\intelligensi-video-lab-mvp-final-acceptance\\playwright"
    : path.join(tmpdir(), "intelligensi-video-lab-audit", "playwright"));
const externalServers = process.env.VIDEO_LAB_E2E_EXTERNAL_SERVERS === "true";
const apiBaseUrl = process.env.VIDEO_LAB_E2E_API_BASE_URL ?? "http://127.0.0.1:5101";
const webBaseUrl = process.env.VIDEO_LAB_E2E_WEB_BASE_URL ?? "http://127.0.0.1:5187";
const apiPort = new URL(apiBaseUrl).port || "5101";
const webPort = new URL(webBaseUrl).port || "5187";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir,
  webServer: externalServers ? undefined : [
    {
      command: "node node_modules/tsx/dist/cli.mjs apps/api/src/server.ts",
      url: `${apiBaseUrl}/v1/health`,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: apiPort,
        VIDEO_LAB_LOCAL_AUTH: "true",
        VIDEO_LAB_ALLOWED_ORIGINS: [
          process.env.VIDEO_LAB_ALLOWED_ORIGINS,
          webBaseUrl,
        ].filter(Boolean).join(","),
      },
    },
    {
      command: `node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webBaseUrl,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_API_PROXY_TARGET: apiBaseUrl,
      },
    },
  ],
  use: { baseURL: webBaseUrl },
});
