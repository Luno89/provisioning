import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, inject } from 'vitest';
import { clusterWide } from './src/infrastructure/testing/cluster-wide.js';

declare module 'vitest' {
  export interface ProvidedContext {
    k3sClusterWide: { adminFile: string; baseline: string[] };
  }
}

const firstToSee = (folder: string, entry: string): boolean => {
  try {
    mkdirSync(join(folder, Buffer.from(entry).toString('base64url')));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
};

afterAll(async () => {
  const { adminFile, baseline } = inject('k3sClusterWide');
  const seen = join(dirname(adminFile), 'left');
  mkdirSync(seen, { recursive: true });
  const added = (await clusterWide(adminFile)).filter((entry) => !baseline.includes(entry)).filter((entry) => firstToSee(seen, entry));
  if (added.length) {
    throw new Error(`the shared k3s holds what no test may leave or make there: ${added.join(', ')}. A test that needs cluster-wide state makes a cluster of its own (privateCluster).`);
  }
}, 0);
