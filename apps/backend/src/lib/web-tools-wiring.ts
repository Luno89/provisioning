import type { Database } from './db-interface.js';
import { resolveWebTools } from './web-tools-resolver.js';
import type { WebTools } from './web-tools.js';
import { ClusterProxyService } from '../services/ClusterProxyService.js';
import { ClusterService } from '../services/ClusterService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';

export async function buildWebTools(db: Database, ownerId?: string): Promise<WebTools> {
  const infra = new InfrastructureService();
  const clusters = new ClusterService(db, infra);
  const proxy = new ClusterProxyService();

  return resolveWebTools(
    {
      db,
      ensurePortForward: (clusterId, serviceKey, kubeconfigPath, target) =>
        proxy.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target),
      kubeconfigFor: async (clusterId: string) => {
        const cluster = await clusters.getByIdUnscoped(clusterId);
        return cluster ? clusters.getKubeconfigPath(cluster) : undefined;
      },
    },
    ownerId,
  );
}
