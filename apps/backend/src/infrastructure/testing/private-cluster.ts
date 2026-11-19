import { inject } from 'vitest';
import { privateClusterFileOf, takePrivateCluster, type PrivateCluster } from './private-clusters.js';

export type { PrivateCluster } from './private-clusters.js';

export async function privateCluster(file: string): Promise<PrivateCluster> {
  const wanted = privateClusterFileOf(file);
  const { folder, files } = inject('privateClusters');
  if (!files.includes(wanted)) throw new Error(`the run started no cluster for ${wanted}: it was not among the files this run was given`);
  return takePrivateCluster(inject('k3s'), folder, wanted);
}
