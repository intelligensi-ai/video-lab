import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('./', import.meta.url));
const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

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
