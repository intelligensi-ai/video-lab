import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const projectRoot = fileURLToPath(new URL('./', import.meta.url));
const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Vitest does not read .env files on its own. Local-only overrides (e.g.
// DEPLOY_STUDIO_RUNTIME_OPENAPI_PATH for the cross-repo contract check) live
// in .env/.env.local, which are gitignored, so load them here. Real
// environment variables and .env.local always win over .env.
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(root('.env.local'));
loadEnvFile(root('.env'));

export default defineConfig({
  root: projectRoot,
  resolve: {
    alias: {
      '@video-lab/contracts': root('./packages/contracts/src/index.ts'),
      '@video-lab/shared': root('./packages/shared/src/index.ts'),
      '@video-lab/domain': root('./packages/domain/src/index.ts'),
      '@video-lab/runtime-adapter': root('./packages/runtime-adapter/src/index.ts'),
      '@video-lab/ui': root('./packages/ui/src/index.ts'),
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
