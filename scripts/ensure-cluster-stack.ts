#!/usr/bin/env -S npx tsx
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { clusterAccessFrom } from '../apps/backend/src/infrastructure/services/ClusterAccess.js';
import { ensureClusterMonitoring } from '../apps/backend/src/activities/cluster-monitoring.js';
import { koalaClusterMonitoring } from '../apps/backend/src/monitoring/lib/cluster-monitoring.js';

async function main(): Promise<void> {
  const rootKubeconfig = process.env.ROOT_KUBECONFIG?.trim();
  if (!rootKubeconfig) throw new Error('ROOT_KUBECONFIG names no kubeconfig for root\'s own cluster; root-telemetry.sh passes the admin kubeconfig k3s wrote');
  const infra = new InfrastructureService();
  const access = clusterAccessFrom(process.env, { role: 'root', rootKubeconfig });
  const reach = access.own();
  const logFile = infra.getLogPath(`cluster-stack-${reach.clusterId}`);
  console.log(`  ▶  root's cluster's monitoring, ingress and telemetry: applying whatever is missing, as the cluster worker does when it starts (log: ${logFile})`);
  await ensureClusterMonitoring({ access, infra }, koalaClusterMonitoring(process.env, reach), logFile);
  console.log('  ✅ root\'s cluster has monitoring and Koala\'s own telemetry stack');
}

main().catch((err: Error) => {
  console.error(`  ❌ root's cluster's monitoring could not be applied: ${err.message}`);
  process.exitCode = 1;
});
