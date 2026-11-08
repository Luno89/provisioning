import fs from 'fs/promises';
import type { Reach } from '../infrastructure/index.js';
import { metricsTokenManifests, monitoringOwner, monitoringPlan, monitoringStackEnv, monitoringStackName, TELEMETRY_SERVICES } from '../monitoring/index.js';
import { newMetricsToken } from '../machines/index.js';
import { ignore } from '@koala/engine-core/failures';
import type { ClusterSteps } from './cluster-steps.js';

export interface MonitoredCluster {
  physicalName: string;
  reach: Reach;
  local: boolean;
  pool?: boolean | undefined;
  machine?: MachineMonitoring | undefined;
  nodePortIngress?: boolean | undefined;
  koala?: boolean | undefined;
}

export interface MachineMonitoring {
  metricsUrl: string;
  remember(tokenHash: string): Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

async function install(steps: ClusterSteps, cluster: MonitoredCluster, logFile: string | undefined): Promise<void> {
  const kubectl = (args: string[]) => steps.access.kubectl(cluster.reach, args);
  const serviceExists = (name: string) => kubectl(['get', 'service', name, '-n', 'monitoring', '--ignore-not-found', '-o', 'name']).then((out) => out.trim() !== '');
  const [apiResources, blackbox, ingressClasses, collector, tempo] = await Promise.all([
    kubectl(['api-resources', '--api-group=monitoring.coreos.com', '-o', 'name']),
    serviceExists('blackbox-exporter'),
    kubectl(['get', 'ingressclass', '-o', 'name']),
    serviceExists(TELEMETRY_SERVICES.collector),
    serviceExists(TELEMETRY_SERVICES.tempo),
  ]);
  const plan = monitoringPlan({ apiResources, blackbox, ingressClasses, telemetry: { collector, tempo } }, cluster.pool, Boolean(cluster.machine));
  if (plan.stacks.length === 0) return;
  if (cluster.machine) {
    const { token, hash } = newMetricsToken();
    for (const manifest of metricsTokenManifests(token)) await steps.access.apply(cluster.reach, JSON.stringify(manifest));
    await cluster.machine.remember(hash);
  }
  const env = monitoringStackEnv({ ...cluster, kubeconfigPath: await steps.access.kubeconfigOf(cluster.reach) }, plan.keepIngress);
  if (logFile) await fs.appendFile(logFile, `[monitoring] ${cluster.physicalName} ${cluster.pool ? 'is watched by Koala\'s servers; installing what its apps need' : cluster.machine ? 'sends its metrics to this Koala; installing what collects them' : `has no monitoring yet; installing ${plan.stacks.join(' and ')}`}\n`).catch(ignore('the log only shows progress, and the work goes on without it'));
  for (const part of plan.stacks) {
    await steps.infra.deploy(monitoringStackName(cluster.physicalName, part), { env, ...(logFile ? { logFile } : {}) });
  }
}

export function ensureClusterMonitoring(steps: ClusterSteps, cluster: MonitoredCluster, logFile?: string): Promise<void> {
  const owned = { ...cluster, physicalName: monitoringOwner(cluster) };
  const running = inFlight.get(owned.physicalName);
  if (running) return running;
  const started = install(steps, owned, logFile).finally(() => inFlight.delete(owned.physicalName));
  inFlight.set(owned.physicalName, started);
  return started;
}
