import fs from 'fs/promises';
import type { Reach } from '../infrastructure/index.js';
import { metricsTokenManifests, MONITORING_CHARTS, monitoringNamespaces, monitoringPlan, monitoringStackEnv, monitoringStackName, TELEMETRY_SERVICES } from '../monitoring/index.js';
import { applyChartCrds } from './chart-crds.js';
import { newMetricsToken } from '../machines/index.js';
import { ignore } from '@koala/engine-core/failures';
import { createDatabase } from '../platform/index.js';
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

const metricsUrlOf = (url: string | { off: string }): string => {
  if (typeof url !== 'string') throw new Error(url.off);
  return url;
};

async function rememberMetricsToken(database: ClusterSteps['database'], clusterId: string, tokenHash: string): Promise<void> {
  const db = createDatabase(database);
  await db.init();
  try {
    await db.infrastructure.patchCluster(clusterId, { metricsTokenHash: tokenHash });
  } finally {
    await db.close().catch(ignore('the token\'s hash is already kept, and a connection that does not close cleanly holds nothing this install needs'));
  }
}

export const machineMonitoringOf = (steps: Pick<ClusterSteps, 'database' | 'machineMetricsUrl'>, clusterId: string): MachineMonitoring => ({
  metricsUrl: metricsUrlOf(steps.machineMetricsUrl),
  remember: (tokenHash) => rememberMetricsToken(steps.database, clusterId, tokenHash),
});

export interface MonitoringSaid {
  logFile?: string | undefined;
  report?: ((line: string) => void) | undefined;
}

async function monitoringPlanOn(steps: Pick<ClusterSteps, 'access'>, cluster: Pick<MonitoredCluster, 'reach' | 'pool'> & { machine?: unknown }) {
  const kubectl = (args: string[]) => steps.access.kubectl(cluster.reach, args);
  const serviceExists = (name: string) => kubectl(['get', 'service', name, '-n', 'monitoring', '--ignore-not-found', '-o', 'name']).then((out) => out.trim() !== '');
  const [apiResources, blackbox, ingressClasses, collector, tempo, listed] = await Promise.all([
    kubectl(['api-resources', '--api-group=monitoring.coreos.com', '-o', 'name']),
    serviceExists('blackbox-exporter'),
    kubectl(['get', 'ingressclass', '-o', 'name']),
    serviceExists(TELEMETRY_SERVICES.collector),
    serviceExists(TELEMETRY_SERVICES.tempo),
    steps.access.helm(cluster.reach, ['list', '-n', MONITORING_CHARTS.namespace, '-o', 'json']),
  ]);
  const charts = Object.fromEntries((JSON.parse(listed) as { name: string; chart: string }[]).map((release) => [release.name, release.chart]));
  return monitoringPlan({ apiResources, blackbox, ingressClasses, telemetry: { collector, tempo }, charts }, cluster.pool, Boolean(cluster.machine));
}

export async function monitoringMissing(steps: Pick<ClusterSteps, 'access'>, cluster: Pick<MonitoredCluster, 'reach' | 'pool'> & { machine: boolean }): Promise<boolean> {
  return (await monitoringPlanOn(steps, cluster)).stacks.length > 0;
}

export async function installClusterMonitoring(steps: Pick<ClusterSteps, 'access' | 'infra'>, cluster: MonitoredCluster, said: MonitoringSaid = {}, wait?: Pause): Promise<void> {
  const { logFile, report } = said;
  const plan = await monitoringPlanOn(steps, cluster);
  if (plan.stacks.length === 0) return;
  if (plan.crdsFirst) await applyChartCrds(steps.access, cluster.reach, MONITORING_CHARTS.stack, MONITORING_CHARTS.repo);
  if (cluster.machine) {
    const { token, hash } = newMetricsToken();
    for (const manifest of metricsTokenManifests(token)) await steps.access.apply(cluster.reach, JSON.stringify(manifest));
    await cluster.machine.remember(hash);
  }
  const env = monitoringStackEnv({ ...cluster, kubeconfigPath: await steps.access.kubeconfigOf(cluster.reach) }, plan.keepIngress);
  const log = (line: string) => {
    report?.(line);
    if (logFile) void fs.appendFile(logFile, `[monitoring] ${line}\n`).catch(ignore('the log only shows progress, and the work goes on without it'));
  };
  log(`${cluster.physicalName} ${cluster.pool ? 'is watched by Koala\'s servers; installing what its apps need' : cluster.machine ? 'sends its metrics to this Koala; installing what collects them' : `has no monitoring yet; installing ${plan.stacks.join(' and ')}`}`);
  for (const part of plan.stacks) {
    const watched = { what: `the monitoring of ${cluster.physicalName}`, reach: cluster.reach, namespaces: monitoringNamespaces(part, plan.keepIngress), log };
    await applyWatched(steps, monitoringStackName(cluster.physicalName, part), { env, ...(logFile ? { logFile } : {}) }, watched, wait);
    await untilRolledOut(steps, watched, wait);
  }
}
