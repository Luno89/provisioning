#!/usr/bin/env -S npx tsx
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { ensureClusterMonitoring } from '../apps/backend/src/activities/cluster-monitoring.js';
import { placedOnPool, SYSTEM_CLUSTER } from '../apps/backend/src/monitoring/lib/cluster-monitoring.js';
import { SYSTEM_KUBECONFIG } from '../apps/backend/src/platform/lib/telemetry.js';
import { writePrivate } from '../apps/backend/src/platform/lib/private-file.js';

async function main(): Promise<void> {
  const infra = new InfrastructureService();
  await writePrivate(SYSTEM_KUBECONFIG, await infra.getManagementClusterKubeconfig(SYSTEM_CLUSTER));
  console.log(`  ▶  the system cluster's monitoring, ingress and telemetry: applying whatever is missing, as the cluster worker does when it starts (log: ${infra.getLogPath(`cluster-stack-${SYSTEM_CLUSTER}`)})`);
  await ensureClusterMonitoring(infra, {
    physicalName: SYSTEM_CLUSTER,
    kubeconfigPath: SYSTEM_KUBECONFIG,
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
