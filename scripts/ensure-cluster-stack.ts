#!/usr/bin/env -S npx tsx
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { clusterAccessFrom } from '../apps/backend/src/infrastructure/services/ClusterAccess.js';
import { ensureClusterMonitoring } from '../apps/backend/src/activities/cluster-monitoring.js';
import { placedOnPool, SYSTEM_CLUSTER } from '../apps/backend/src/monitoring/lib/cluster-monitoring.js';
import { writePrivate } from '../apps/backend/src/platform/lib/private-file.js';

async function main(): Promise<void> {
  const infra = new InfrastructureService();
  const rootKubeconfig = `/tmp/kubeconfig-${SYSTEM_CLUSTER}`;
  await writePrivate(rootKubeconfig, await infra.getManagementClusterKubeconfig(SYSTEM_CLUSTER));
  const access = clusterAccessFrom(process.env, { role: 'root', rootKubeconfig });
  console.log(`  ▶  the system cluster's monitoring, ingress and telemetry: applying whatever is missing, as the cluster worker does when it starts (log: ${infra.getLogPath(`cluster-stack-${SYSTEM_CLUSTER}`)})`);
  await ensureClusterMonitoring({ access, infra }, {
    physicalName: SYSTEM_CLUSTER,
    reach: access.own(),
    local: true,
    pool: placedOnPool(process.env, SYSTEM_CLUSTER),
    nodePortIngress: Boolean(process.env.INSTANCE_MACHINE_ID),
    koala: true,
  }, infra.getLogPath(`cluster-stack-${SYSTEM_CLUSTER}`));
  console.log('  ✅ the system cluster has monitoring and Koala\'s own telemetry stack');
}

main().catch((err: Error) => {
  console.error(`  ❌ the system cluster's monitoring could not be applied: ${err.message}`);
  process.exitCode = 1;
});
