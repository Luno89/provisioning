import { defineConfig } from 'vitest/config';
import { REPORTERS } from '../projects.js';

export default defineConfig({
  test: {
    reporters: REPORTERS,
    projects: [
      { extends: true, test: { name: 'unit', testTimeout: 0, include: ['*.unit.fixture.ts'] } },
      { extends: true, test: { name: 'component', testTimeout: 0, include: ['*.component.fixture.ts'] } },
    ],
  },
});
