#!/usr/bin/env -S npx tsx
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { clusterAccessFrom } from '../apps/backend/src/infrastructure/services/ClusterAccess.js';
import { ROOT_CLUSTER_ID } from '../apps/backend/src/infrastructure/lib/cluster-places.js';
import { ensureClusterMonitoring } from '../apps/backend/src/activities/cluster-monitoring.js';
import { placedOnPool } from '../apps/backend/src/monitoring/lib/cluster-monitoring.js';
import { writePrivate } from '../apps/backend/src/platform/lib/private-file.js';

async function main(): Promise<void> {
  const infra = new InfrastructureService();
  const rootKubeconfig = `/tmp/kubeconfig-${ROOT_CLUSTER_ID}`;
  await writePrivate(rootKubeconfig, await infra.getManagementClusterKubeconfig(ROOT_CLUSTER_ID));
  const access = clusterAccessFrom(process.env, { role: 'root', rootKubeconfig });
  const reach = access.own();
  console.log(`  ▶  root's cluster's monitoring, ingress and telemetry: applying whatever is missing, as the cluster worker does when it starts (log: ${infra.getLogPath(`cluster-stack-${reach.clusterId}`)})`);
  await ensureClusterMonitoring({ access, infra }, {
    physicalName: reach.clusterId,
    reach,
    local: true,
    pool: placedOnPool(process.env, reach),
    nodePortIngress: Boolean(process.env.INSTANCE_MACHINE_ID),
    koala: true,
  }, infra.getLogPath(`cluster-stack-${reach.clusterId}`));
  console.log('  ✅ root\'s cluster has monitoring and Koala\'s own telemetry stack');
}

main().catch((err: Error) => {
  console.error(`  ❌ root's cluster's monitoring could not be applied: ${err.message}`);
  process.exitCode = 1;
});
