import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { REPORTERS } from '../projects.js';

const guard = (name: string): string => fileURLToPath(new URL(`../${name}-guard.ts`, import.meta.url));

export default defineConfig({
  test: {
    reporters: REPORTERS,
    projects: [
      { extends: true, test: { name: 'component', include: ['*.component.fixture.ts'], setupFiles: [guard('component')] } },
      { extends: true, test: { name: 'container', include: ['*.container.fixture.ts'], setupFiles: [guard('container')] } },
    ],
  },
});
