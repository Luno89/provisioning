import { createDatabase } from '../platform/index.js';
import { InfrastructureService, ClusterService, namespaceOf, assessWorkload, type WorkloadHealth } from '../infrastructure/index.js';
import { handedKubeconfig } from './cluster-access.js';

export interface CheckWorkloadArgs {
  name: string;
  namespace?: string | undefined;
  clusterId: string;
  kubeconfig?: string | undefined;
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

    const kubeconfig = args.kubeconfig ? await handedKubeconfig(args.clusterId, args.kubeconfig) : await clusters.getKubeconfigPath(cluster);
    const raw = await infra.runKubectl(
      ['get', 'pods', '-n', namespaceOf(args), '-o', 'json'],
      kubeconfig,
    );
    return assessWorkload(JSON.parse(raw));
  } catch (err) {
    return { health: 'unknown', reason: `could not read the workload: ${(err as Error).message}` };
  } finally {
    await db.close();
  }
}
