import { clusterAccessFrom } from '../infrastructure/wiring/cluster-access.js';
import { createDatabase, roleFromEnv } from '../platform/index.js';
import { InfrastructureService, ClusterService } from '../infrastructure/index.js';

export interface VerifyGpuRuntimeArgs {
  clusterId: string;
  vendor: 'nvidia' | 'amd';
}


export async function VerifyGpuRuntimeActivity(args: VerifyGpuRuntimeArgs): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const infra = new InfrastructureService();
    const clusters = new ClusterService(db, infra, clusterAccessFrom(process.env, { role: roleFromEnv(process.env).role, clusters: db.infrastructure }));
    const cluster = await clusters.getByIdUnscoped(args.clusterId);
    if (!cluster) throw new Error(`Cluster ${args.clusterId} no longer exists`);

    const kubeconfig = await clusters.getKubeconfigPath(cluster);
    await infra.installGpuDevicePlugin(args.vendor, kubeconfig);
    await infra.verifyGpuRuntimeSchedulable(args.vendor, kubeconfig);
  } finally {
    await db.close();
  }
}
