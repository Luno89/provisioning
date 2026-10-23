import fs from 'fs/promises';
import type { InfrastructureService } from '../infrastructure/index.js';
import { monitoringPlan, monitoringStackEnv, monitoringStackName, TELEMETRY_SERVICES } from '../monitoring/index.js';

export interface MonitoredCluster {
  physicalName: string;
  kubeconfigPath: string;
  local: boolean;
  pool?: boolean | undefined;
}

const inFlight = new Map<string, Promise<void>>();

async function install(infra: InfrastructureService, cluster: MonitoredCluster, logFile: string | undefined): Promise<void> {
  const serviceExists = (name: string) => infra.runKubectl(['get', 'service', name, '-n', 'monitoring', '--ignore-not-found', '-o', 'name'], cluster.kubeconfigPath).then((out) => out.trim() !== '');
  const [apiResources, blackbox, ingressClasses, collector, tempo] = await Promise.all([
    infra.runKubectl(['api-resources', '--api-group=monitoring.coreos.com', '-o', 'name'], cluster.kubeconfigPath),
    serviceExists('blackbox-exporter'),
    infra.runKubectl(['get', 'ingressclass', '-o', 'name'], cluster.kubeconfigPath),
    serviceExists(TELEMETRY_SERVICES.collector),
    serviceExists(TELEMETRY_SERVICES.tempo),
  ]);
  const plan = monitoringPlan({ apiResources, blackbox, ingressClasses, telemetry: { collector, tempo } }, cluster.pool);
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
