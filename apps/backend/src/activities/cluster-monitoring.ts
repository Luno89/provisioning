import fs from 'fs/promises';
import type { InfrastructureService } from '../infrastructure/index.js';
import { metricsTokenManifests, monitoringPlan, monitoringStackEnv, monitoringStackName, TELEMETRY_SERVICES } from '../monitoring/index.js';
import { newMetricsToken } from '../machines/index.js';
import { ignore } from '@koala/engine-core/failures';

export interface MonitoredCluster {
  physicalName: string;
  kubeconfigPath: string;
  local: boolean;
  pool?: boolean | undefined;
  machine?: MachineMonitoring | undefined;
}

export interface MachineMonitoring {
  metricsUrl: string;
  remember(tokenHash: string): Promise<void>;
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
  const plan = monitoringPlan({ apiResources, blackbox, ingressClasses, telemetry: { collector, tempo } }, cluster.pool, Boolean(cluster.machine));
  if (plan.stacks.length === 0) return;
  if (cluster.machine) {
    const { token, hash } = newMetricsToken();
    for (const manifest of metricsTokenManifests(token)) await infra.applyManifest(JSON.stringify(manifest), cluster.kubeconfigPath);
    await cluster.machine.remember(hash);
  }
  const env = monitoringStackEnv(cluster, plan.keepIngress);
  if (logFile) await fs.appendFile(logFile, `[monitoring] ${cluster.physicalName} ${cluster.pool ? 'is watched by Koala\'s servers; installing what its apps need' : cluster.machine ? 'sends its metrics to this Koala; installing what collects them' : `has no monitoring yet; installing ${plan.stacks.join(' and ')}`}\n`).catch(ignore('the log only shows progress, and the work goes on without it'));
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
