import { createDatabase } from '../lib/db-interface.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ClusterService } from '../services/ClusterService.js';

export interface VerifyGpuRuntimeArgs {
  clusterId: string;
  vendor: 'nvidia' | 'amd';
}

export { verifyGpuRuntimeActivityMeta } from '../lib/activity-timeouts.js';

export async function VerifyGpuRuntimeActivity(args: VerifyGpuRuntimeArgs): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const infra = new InfrastructureService();
    const clusters = new ClusterService(db, infra);
    const cluster = await clusters.getByIdUnscoped(args.clusterId);
    if (!cluster) throw new Error(`Cluster ${args.clusterId} no longer exists`);

    const kubeconfig = await clusters.getKubeconfigPath(cluster);
    await infra.installGpuDevicePlugin(args.vendor, kubeconfig);
    await infra.verifyGpuRuntimeSchedulable(args.vendor, kubeconfig);
  } finally {
    await db.close();
  }
}
