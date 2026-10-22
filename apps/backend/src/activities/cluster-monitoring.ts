import fs from 'fs/promises';
import type { InfrastructureService } from '../infrastructure/index.js';
import { monitoringPlan, monitoringStackEnv, monitoringStackName } from '../monitoring/index.js';

export interface MonitoredCluster {
  physicalName: string;
  kubeconfigPath: string;
  local: boolean;
  pool?: boolean | undefined;
}

const inFlight = new Map<string, Promise<void>>();

async function install(infra: InfrastructureService, cluster: MonitoredCluster, logFile: string | undefined): Promise<void> {
  const [apiResources, blackbox, ingressClasses] = await Promise.all([
    infra.runKubectl(['api-resources', '--api-group=monitoring.coreos.com', '-o', 'name'], cluster.kubeconfigPath),
    infra.runKubectl(['get', 'service', 'blackbox-exporter', '-n', 'monitoring', '--ignore-not-found', '-o', 'name'], cluster.kubeconfigPath).then((out) => out.trim() !== ''),
    infra.runKubectl(['get', 'ingressclass', '-o', 'name'], cluster.kubeconfigPath),
  ]);
  const plan = monitoringPlan({ apiResources, blackbox, ingressClasses }, cluster.pool);
  if (plan.stacks.length === 0) return;
  const env = monitoringStackEnv(cluster, plan.keepIngress);
  if (logFile) await fs.appendFile(logFile, `[monitoring] ${cluster.physicalName} ${cluster.pool ? 'is watched by Koala\'s servers; installing what its apps need' : `has no monitoring yet; installing ${plan.stacks.join(' and ')}`}\n`).catch(() => {});
  for (const part of plan.stacks) {
    await infra.deploy(monitoringStackName(cluster.physicalName, part), { env, ...(logFile ? { logFile } : {}) });
  }
}

export function ensureClusterMonitoring(infra: InfrastructureService, cluster: MonitoredCluster, logFile?: string): Promise<void> {
  const running = inFlight.get(cluster.physicalName);
  if (running) return running;
  const started = install(infra, cluster, logFile).finally(() => inFlight.delete(cluster.physicalName));
  inFlight.set(cluster.physicalName, started);
  return started;
}
