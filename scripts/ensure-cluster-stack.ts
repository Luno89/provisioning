#!/usr/bin/env -S npx tsx
import { InfrastructureService, terraformPlacesFor } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';
import { clusterAccessFrom } from '../apps/backend/src/infrastructure/services/ClusterAccess.js';
import { ensureClusterMonitoring } from '../apps/backend/src/activities/cluster-monitoring.js';
import { koalaClusterMonitoring } from '../apps/backend/src/monitoring/lib/cluster-monitoring.js';

async function main(): Promise<void> {
  const rootKubeconfig = process.env.ROOT_KUBECONFIG?.trim();
  if (!rootKubeconfig) throw new Error('ROOT_KUBECONFIG names no kubeconfig for root\'s own cluster; root-telemetry.sh passes the admin kubeconfig k3s wrote');
  const dataDir = process.env.DATA_DIR?.trim();
  if (!dataDir) throw new Error('DATA_DIR names no data folder for root; root-telemetry.sh passes the one root\'s settings name');
  const infra = new InfrastructureService(terraformPlacesFor({ kind: 'local' }, dataDir));
  const access = clusterAccessFrom({ here: { root: true }, serviceAccount: undefined, rootKubeconfig, chartSources: undefined }, { role: 'root' });
  const reach = access.own();
  const logFile = infra.getLogPath(`cluster-stack-${reach.clusterId}`);
  console.log(`  ▶  root's cluster's monitoring, ingress and telemetry: applying whatever is missing, as the cluster worker does when it starts (log: ${logFile})`);
  await ensureClusterMonitoring({ access, infra }, koalaClusterMonitoring(false, reach), logFile);
  console.log('  ✅ root\'s cluster has monitoring and Koala\'s own telemetry stack');
}

main().catch((err: Error) => {
  console.error(`  ❌ root's cluster's monitoring could not be applied: ${err.message}`);
  process.exitCode = 1;
});
