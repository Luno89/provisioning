import { defineConfig } from 'vitest/config';
import { OWN_PROCESSES } from '../projects.js';

export default defineConfig({
  test: { include: ['*.leaves.ts'], setupFiles: [OWN_PROCESSES], testTimeout: 0, hookTimeout: 0 },
});
