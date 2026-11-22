import { defineConfig } from 'vitest/config';
import { REPORTERS } from '../projects.js';

export default defineConfig({
  test: { include: ['*.fails.ts'], reporters: REPORTERS },
});
