import { createDatabase } from '../lib/db-interface.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ClusterService } from '../services/ClusterService.js';
import { sanitizeNamespace } from '../lib/model-registry.js';
import { assessWorkload, type WorkloadHealth } from '../lib/workload-health.js';

export interface CheckWorkloadArgs {
  name: string;
  clusterId: string;
}

export interface CheckWorkloadResult {
  health: WorkloadHealth;
  reason: string;
}

export async function CheckWorkloadActivity(args: CheckWorkloadArgs): Promise<CheckWorkloadResult> {
  const db = createDatabase();
  await db.init();
  try {
    const infra = new InfrastructureService();
    const clusters = new ClusterService(db, infra);
    const cluster = await clusters.getByIdUnscoped(args.clusterId);
    if (!cluster) return { health: 'unknown', reason: 'cluster no longer exists' };

    const kubeconfig = await clusters.getKubeconfigPath(cluster);
    const raw = await infra.runKubectl(
      ['get', 'pods', '-n', sanitizeNamespace(args.name), '-o', 'json'],
      kubeconfig,
    );
    return assessWorkload(JSON.parse(raw));
  } catch (err) {
    return { health: 'unknown', reason: `could not read the workload: ${(err as Error).message}` };
  } finally {
    await db.close();
  }
}
