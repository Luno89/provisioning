import type { Setup } from '../../tests/tiers/projects.js';

export const OPTIONAL_SETUPS: Record<string, Setup> = {
  k3s: { globalSetup: './vitest.k3s-setup.ts', setupFiles: ['./vitest.k3s-check.ts'] },
  minio: { globalSetup: './vitest.minio-setup.ts' },
};
