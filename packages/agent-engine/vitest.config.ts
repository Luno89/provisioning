import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { setupFiles: ['../../tests/coupling/vitest-setup.ts'] },
});
