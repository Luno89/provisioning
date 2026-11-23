import { defineConfig } from 'vitest/config';
import { REPORTERS, STATUS_SETUP } from '../projects.js';

export default defineConfig({
  test: { name: 'integration', include: ['*.held.ts'], reporters: REPORTERS, setupFiles: [STATUS_SETUP], testTimeout: 0, hookTimeout: 0 },
});
