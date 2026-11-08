import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { encryptValue, type ClusterMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { ClusterAccess } from '../../infrastructure/index.js';
import { testClusterAccess } from '../../infrastructure/testing/cluster-access.js';
import type { PoolMonitor } from '../services/MonitoringService.js';
import { monitoringDepsFor, type MonitoredClusters, type PrometheusProxy } from './monitoring.js';

const KEY = 'monitoring-wiring-key' as never;
const desk = { id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo' } as ClusterMetadata;
const system = { id: 'machine-koala', name: 'koala', provider: 'machine', machineId: 'koala', status: 'healthy', isSystem: true } as ClusterMetadata;

function parts() {
  const access = mock<ClusterAccess>();
  const clusters = mock<MonitoredClusters>({ access });
  const proxy = mock<PrometheusProxy>();
  return { access, clusters, proxy, db: memoryDatabase() };
}

describe('the monitoring both the backend and the engine worker build', () => {
  it('reaches each cluster\'s Prometheus through the proxy, with the kubeconfig ClusterAccess gives for that cluster', async () => {
    const { access, clusters, proxy, db } = parts();
    access.kubeconfigOf.calledWith('machine-desk').mockResolvedValue('/run/koala/kubeconfig-machine-machine-desk');
    proxy.serviceUrl.mockResolvedValue('http://127.0.0.1:41000/');
    const deps = monitoringDepsFor({ db, clusters, proxy });
    expect(await deps.prometheus(desk)).toBeDefined();
    expect(proxy.serviceUrl).toHaveBeenCalledWith('machine-desk', 'prometheus', '/run/koala/kubeconfig-machine-machine-desk');
  });

  it('asks the proxy for nothing when ClusterAccess cannot reach the cluster, and fails with why', async () => {
    const { access, clusters, proxy, db } = parts();
    access.kubeconfigOf.mockRejectedValue(new Error('desk is stopped until something runs on it'));
    await expect(monitoringDepsFor({ db, clusters, proxy }).prometheus(desk)).rejects.toThrow('desk is stopped until something runs on it');
    expect(proxy.serviceUrl).not.toHaveBeenCalled();
  });

  it('runs kubectl, helm and apply through ClusterAccess by the cluster\'s id', async () => {
    const { access, clusters, proxy, db } = parts();
    access.kubectl.mockResolvedValue('probes');
    access.helm.mockResolvedValue('values');
    access.apply.mockResolvedValue('applied');
    const deps = monitoringDepsFor({ db, clusters, proxy });
    expect(await deps.kubectl(desk, ['get', 'probes', '-A'])).toBe('probes');
    expect(await deps.helm(desk, ['get', 'values', 'kube-prometheus-stack'])).toBe('values');
    await deps.apply(desk, 'kind: PrometheusRule');
    expect(access.kubectl).toHaveBeenCalledWith('machine-desk', ['get', 'probes', '-A']);
    expect(access.helm).toHaveBeenCalledWith('machine-desk', ['get', 'values', 'kube-prometheus-stack']);
    expect(access.apply).toHaveBeenCalledWith('machine-desk', 'kind: PrometheusRule');
  });

  it('asks the pool only about the system cluster, and finds the system cluster through the cluster service', async () => {
    const { clusters, proxy, db } = parts();
    const pool = mock<PoolMonitor>();
    clusters.getSystemClusterEntry.mockResolvedValue(system);
    const deps = monitoringDepsFor({ db, clusters, proxy, pool });
    expect(deps.pool?.(system)).toBe(pool);
    expect(deps.pool?.(desk)).toBeUndefined();
    expect(await deps.systemCluster()).toBe(system);
  });

  it('carries the machine status and root\'s own alerts only as given', () => {
    const { clusters, proxy, db } = parts();
    const online = (deviceId: string) => ({ online: deviceId === 'desk' });
    expect(monitoringDepsFor({ db, clusters, proxy, machineStatus: online, rootAlerts: true })).toMatchObject({ machineStatus: online, rootAlerts: true });
    const bare = monitoringDepsFor({ db, clusters, proxy });
    expect('machineStatus' in bare).toBe(false);
    expect(bare.rootAlerts).toBeUndefined();
  });
});

describe('the same monitoring over ClusterAccess itself', () => {
  it('runs a machine\'s kubectl on the kubeconfig sealed on its record, and hands Prometheus\'s proxy that same file', async () => {
    const db = memoryDatabase();
    await db.infrastructure.saveCluster({ ...desk, kubeconfigEnc: encryptValue('server: https://100.64.0.7:6443', KEY) });
    const asked: string[][] = [];
    const folder = mkdtempSync(join(tmpdir(), 'koala-monitoring-wiring-'));
    const access = testClusterAccess(db, { dataKey: KEY, folder, answers: async (args) => { asked.push([...args]); return 'answered'; } });
    const proxy = mock<PrometheusProxy>();
    proxy.serviceUrl.mockResolvedValue('http://127.0.0.1:41000/');
    const deps = monitoringDepsFor({ db, clusters: { access, getSystemClusterEntry: async () => system }, proxy });
    expect(await deps.kubectl(desk, ['get', 'probes', '-A'])).toBe('answered');
    expect(asked).toEqual([['get', 'probes', '-A']]);
    await deps.prometheus(desk);
    const [, , kubeconfig] = proxy.serviceUrl.mock.calls[0]!;
    expect(kubeconfig).toBe(join(folder, 'kubeconfig-machine-machine-desk'));
    expect(readFileSync(kubeconfig, 'utf8')).toBe('server: https://100.64.0.7:6443');
  });

  it('fails with ClusterAccess\'s refusal for a stopped machine, running nothing', async () => {
    const db = memoryDatabase();
    await db.infrastructure.saveCluster({ ...desk, status: 'stopped' });
    const asked: string[][] = [];
    const access = testClusterAccess(db, { dataKey: KEY, answers: async (args) => { asked.push([...args]); return ''; } });
    const deps = monitoringDepsFor({ db, clusters: { access, getSystemClusterEntry: async () => system }, proxy: mock<PrometheusProxy>() });
    await expect(deps.kubectl(desk, ['get', 'pods'])).rejects.toThrow('desk is stopped until something runs on it');
    expect(asked).toEqual([]);
  });
});
