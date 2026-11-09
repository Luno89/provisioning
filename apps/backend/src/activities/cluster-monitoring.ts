import fs from 'fs/promises';
import type { Reach } from '../infrastructure/index.js';
import { metricsTokenManifests, monitoringNamespaces, monitoringPlan, monitoringStackEnv, monitoringStackName, TELEMETRY_SERVICES } from '../monitoring/index.js';
import { newMetricsToken } from '../machines/index.js';
import { ignore } from '@koala/engine-core/failures';
import type { ClusterSteps } from './cluster-steps.js';
import { applyWatched, untilRolledOut, type Pause } from './watched-apply.js';

export interface MonitoredCluster {
  physicalName: string;
  reach: Reach;
  pool?: boolean | undefined;
  machine?: MachineMonitoring | undefined;
  koala?: boolean | undefined;
}

export interface MachineMonitoring {
  metricsUrl: string;
  remember(tokenHash: string): Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

async function install(steps: Pick<ClusterSteps, 'access' | 'infra'>, cluster: MonitoredCluster, logFile: string | undefined, wait: Pause | undefined): Promise<void> {
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
  const log = (line: string) => { if (logFile) void fs.appendFile(logFile, `[monitoring] ${line}\n`).catch(ignore('the log only shows progress, and the work goes on without it')); };
  for (const part of plan.stacks) {
    const watched = { what: `the monitoring of ${cluster.physicalName}`, reach: cluster.reach, namespaces: monitoringNamespaces(part, plan.keepIngress), log };
    await applyWatched(steps, monitoringStackName(cluster.physicalName, part), { env, ...(logFile ? { logFile } : {}) }, watched, wait);
    await untilRolledOut(steps, watched, wait);
  }
}

export function ensureClusterMonitoring(steps: Pick<ClusterSteps, 'access' | 'infra'>, cluster: MonitoredCluster, logFile?: string, wait?: Pause): Promise<void> {
  const running = inFlight.get(cluster.physicalName);
  if (running) return running;
  const started = install(steps, cluster, logFile, wait).finally(() => inFlight.delete(cluster.physicalName));
  inFlight.set(cluster.physicalName, started);
  return started;
}
