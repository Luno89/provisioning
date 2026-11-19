import { defineConfig } from 'vitest/config';
import { REPORTERS } from '../projects.js';

export default defineConfig({
  test: { include: ['*.held.ts'], reporters: REPORTERS, testTimeout: 0, hookTimeout: 0 },
});
