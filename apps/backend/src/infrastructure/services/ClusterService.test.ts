import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import { asPerson, encryptValue, principalOf, type ClusterMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { Shell } from '../lib/shell.js';
import { ClusterService } from './ClusterService.js';
import type { InfrastructureService } from './InfrastructureService.js';
import type { TemporalBridge } from './TemporalBridge.js';
import { testClusterAccess } from '../testing/cluster-access.js';

const MASTER = 'cluster-service-test-key';
const NODES = JSON.stringify({ items: [{ metadata: { labels: {} }, status: { allocatable: { cpu: '8', memory: '32Gi', 'nvidia.com/gpu': '1' } } }] });
const k3d = (id: string, status: ClusterMetadata['status'] = 'healthy', extra: Partial<ClusterMetadata> = {}): ClusterMetadata => ({ id, name: id, provider: 'k3d', status, ownerId: 'bo', ...extra });
const originalEnv = { NODE_ENV: process.env.NODE_ENV, HCLOUD_TOKEN: process.env.HCLOUD_TOKEN };

function setup(places: { shell?: Shell; koalaMachineId?: string | undefined } = {}) {
  const noHostTools = mockFn<Shell>();
  noHostTools.mockRejectedValue(new Error('not on this host'));
  const db: Database = memoryDatabase();
  const infra = mock<InfrastructureService>();
  infra.getManagementClusterKubeconfig.mockRejectedValue(new Error('no management cluster here'));
  infra.listLocalClusters.mockResolvedValue([]);
  const kubeconfigDir = mkdtempSync(join(tmpdir(), 'cluster-service-'));
  return { db, infra, kubeconfigDir, service: new ClusterService(db, infra, testClusterAccess(db, { answers: (args) => infra.runKubectl([...args]), dataKey: MASTER, koalaMachineId: places.koalaMachineId, folder: kubeconfigDir, serviceAccount: { host: 'kubernetes.default.svc', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' } }), { kubeconfigDir, shell: noHostTools, ...places }) };
}

beforeEach(() => { process.env.NODE_ENV = 'development'; delete process.env.HCLOUD_TOKEN; });
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe('a machine\'s own cluster', () => {
  const machine = (extra: Partial<ClusterMetadata> = {}): ClusterMetadata => ({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'healthy', ownerId: 'bo', machineId: 'desk', ...extra });

  it('opens the kubeconfig its machine handed over, sealed on the record, into a file only this process reads', async () => {
    const { db, service, kubeconfigDir } = setup();
    const sealed = machine({ kubeconfigEnc: encryptValue('server: https://100.64.0.7:6443', MASTER) });
    await db.infrastructure.saveCluster(sealed);
    const where = await service.getKubeconfigPath(sealed);
    expect(where).toBe(join(kubeconfigDir, 'kubeconfig-machine-machine-desk'));
    expect(readFileSync(where, 'utf8')).toBe('server: https://100.64.0.7:6443');
    expect(statSync(where).mode & 0o777).toBe(0o600);
  });

  it('says it has not started rather than fall back to another cluster', async () => {
    const { db, service } = setup();
    await db.infrastructure.saveCluster(machine());
    await expect(service.getKubeconfigPath(machine())).rejects.toThrow('desk has not started yet, so there is no way to reach it');
  });
});

describe('whether a cluster runs as local containers', () => {
  it('runs a provider with no keys as a local cluster named for it, on a dev box only', () => {
    const { service } = setup();
    const aws = k3d('c1', 'healthy', { provider: 'aws', name: 'lab' });
    expect(service.isMockCloud(aws)).toBe(true);
    expect(service.getPhysicalClusterName(aws)).toBe('mock-aws-lab');
    process.env.NODE_ENV = 'production';
    expect(service.isMockCloud(aws)).toBe(false);
    expect(service.getPhysicalClusterName(aws)).toBe('lab');
  });

  it('never runs a provider that makes real machines as a mock', () => {
    const { service } = setup();
    expect(service.isMockCloud(k3d('c1', 'healthy', { provider: 'hetzner' }))).toBe(false);
    expect(service.getPhysicalClusterName(k3d('c1', 'healthy', { provider: 'hetzner', name: 'vm' }))).toBe('vm');
  });
});

describe('the system cluster', () => {
  it('is healthy with its capacity and a private kubeconfig when the management cluster answers', async () => {
    const { service, infra, kubeconfigDir } = setup();
    infra.getManagementClusterKubeconfig.mockResolvedValue('apiVersion: v1');
    infra.runKubectl.mockResolvedValue(NODES);
    const entry = await service.getSystemClusterEntry();
    expect(entry).toMatchObject({ id: 'provisioning-lunorica', status: 'healthy', gpuEnabled: true, isSystem: true, provider: 'k3d', capacity: { cpuCores: 8, ramGb: 32, gpuCount: 1, gpuVendor: 'nvidia' } });
    const written = join(kubeconfigDir, 'kubeconfig-provisioning-lunorica');
    expect(readFileSync(written, 'utf8')).toBe('apiVersion: v1');
    expect(statSync(written).mode & 0o777).toBe(0o600);
  });

  it('adds the VRAM nvidia-smi reports when the nodes do not label it', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits').mockResolvedValue({ stdout: '24576\n', stderr: '' });
    const { service, infra } = setup({ shell });
    infra.getManagementClusterKubeconfig.mockResolvedValue('apiVersion: v1');
    infra.runKubectl.mockResolvedValue(NODES);
    expect((await service.getSystemClusterEntry()).capacity).toMatchObject({ gpuVramMib: 24576 });
  });

  it('shows its capacity without VRAM when nvidia-smi does not answer, and without capacity when its nodes cannot be read', async () => {
    const shell = mockFn<Shell>();
    shell.mockRejectedValue(new Error('nvidia-smi: not found'));
    const { service, infra } = setup({ shell });
    infra.getManagementClusterKubeconfig.mockResolvedValue('apiVersion: v1');
    infra.runKubectl.mockResolvedValue(NODES);
    expect((await service.getSystemClusterEntry()).capacity).not.toHaveProperty('gpuVramMib');
    infra.runKubectl.mockRejectedValue(new Error('refused'));
    const without = await service.getSystemClusterEntry();
    expect(without.status).toBe('healthy');
    expect(without.capacity).toBeUndefined();
  });

  it('is failed when the management cluster does not answer', async () => {
    const { service } = setup();
    expect((await service.getSystemClusterEntry()).status).toBe('failed');
  });

  it('installs the GPU device plugin when the toolkit is there', async () => {
    const { service, infra, kubeconfigDir } = setup();
    infra.getManagementClusterKubeconfig.mockResolvedValue('apiVersion: v1');
    await service.ensureSystemClusterGpuReady();
    expect(infra.checkGpuToolkit).toHaveBeenCalledWith('nvidia');
    expect(infra.installGpuDevicePlugin).toHaveBeenCalledWith('nvidia', join(kubeconfigDir, 'kubeconfig-provisioning-lunorica'));
  });

  it('skips the GPU device plugin, without failing, when the host has no toolkit or no management cluster', async () => {
    const { service, infra } = setup();
    infra.getManagementClusterKubeconfig.mockResolvedValue('apiVersion: v1');
    infra.checkGpuToolkit.mockRejectedValue(new Error('NVIDIA GPU toolkit not found'));
    await expect(service.ensureSystemClusterGpuReady()).resolves.toBeUndefined();
    expect(infra.installGpuDevicePlugin).not.toHaveBeenCalled();
    infra.getManagementClusterKubeconfig.mockRejectedValue(new Error('no management cluster'));
    await expect(service.ensureSystemClusterGpuReady()).resolves.toBeUndefined();
  });
});

describe('reconciling clusters against k3d', () => {
  it('removes a cluster deleted outside Koala with its deployments and kubeconfig, and nothing else', async () => {
    const { service, db, infra, kubeconfigDir } = setup();
    infra.listLocalClusters.mockResolvedValue(['kept']);
    await db.infrastructure.saveCluster(k3d('kept'));
    await db.infrastructure.saveCluster(k3d('gone'));
    await db.infrastructure.saveCluster(k3d('leaving', 'destroying'));
    await db.infrastructure.saveDeployment({ id: 'app-gone', name: 'app-gone', clusterId: 'gone', strategy: 'helm', status: 'running' });
    await db.infrastructure.saveDeployment({ id: 'app-kept', name: 'app-kept', clusterId: 'kept', strategy: 'helm', status: 'running' });
    writeFileSync(join(kubeconfigDir, 'kubeconfig-gone'), 'x');
    const io = mock<SocketServer>();
    const room = mock<{ emit: (event: string, payload: unknown) => void }>();
    io.to.calledWith('user:bo').mockReturnValue(room as never);

    await service.reconcileAllClusters(io);

    expect((await db.infrastructure.getClusters()).map((cluster) => cluster.id).sort()).toEqual(['kept', 'leaving']);
    expect((await db.infrastructure.getDeployments()).map((dep) => dep.id)).toEqual(['app-kept']);
    expect(existsSync(join(kubeconfigDir, 'kubeconfig-gone'))).toBe(false);
    expect(room.emit).toHaveBeenCalledWith('resource-destroyed', { id: 'gone', type: 'cluster', name: 'gone', outOfBand: true });
  });

  it('answers the system cluster first and leaves other providers\' clusters alone', async () => {
    const { service, db } = setup();
    await db.infrastructure.saveCluster(k3d('vm', 'healthy', { provider: 'hetzner' }));
    await db.infrastructure.saveCluster(k3d('gpu', 'healthy', { gpuEnabled: true }));
    const all = await service.reconcileAllClusters();
    expect(all.map((cluster) => cluster.id)).toEqual(['provisioning-lunorica', 'vm', 'gpu']);
  });

  it('marks a cluster stuck provisioning for a quarter of an hour failed when its containers are gone, and healthy when its stack is up', async () => {
    const { service, db, infra } = setup();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await db.infrastructure.saveCluster(k3d('lost', 'provisioning', { createdAt: old }));
    await db.infrastructure.saveCluster(k3d('up', 'provisioning', { createdAt: old }));
    await db.infrastructure.saveCluster(k3d('young', 'provisioning', { createdAt: new Date().toISOString() }));
    infra.listLocalClusters.mockResolvedValue(['up', 'young']);
    infra.runHelm.mockResolvedValue(JSON.stringify([{ name: 'kube-prometheus-stack' }, { name: 'traefik' }]));
    const io = mock<SocketServer>();
    await service.reconcileAllClusters(io);
    const status = async (id: string) => (await db.infrastructure.getClusters()).find((cluster) => cluster.id === id)?.status;
    expect(await status('lost')).toBe('failed');
    expect(await status('up')).toBe('healthy');
    expect(await status('young')).toBe('provisioning');
    expect(io.emit).toHaveBeenCalledWith('cluster-updated');
  });

  it('marks a stuck cluster failed when its stack is missing pieces and leaves it when helm cannot be asked', async () => {
    const { service, db, infra } = setup();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await db.infrastructure.saveCluster(k3d('half', 'provisioning', { createdAt: old }));
    infra.listLocalClusters.mockResolvedValue(['half']);
    infra.runHelm.mockResolvedValueOnce(JSON.stringify([{ name: 'traefik' }]));
    await service.reconcileAllClusters();
    expect((await db.infrastructure.getClusters())[0]?.status).toBe('failed');
    await db.infrastructure.saveCluster(k3d('half', 'provisioning', { createdAt: old }));
    infra.runHelm.mockRejectedValueOnce(new Error('helm is away'));
    await service.reconcileAllClusters();
    expect((await db.infrastructure.getClusters())[0]?.status).toBe('provisioning');
  });
});

describe('getAll', () => {
  it('shows each person the system cluster and their own clusters, and the operator the system cluster too', async () => {
    const { service, db, infra } = setup();
    infra.listLocalClusters.mockResolvedValue(['mine', 'theirs']);
    await db.infrastructure.saveCluster(k3d('mine', 'healthy', { ownerId: 'bo' }));
    await db.infrastructure.saveCluster(k3d('theirs', 'healthy', { ownerId: 'someone-else' }));
    const bo = (await service.getAll(asPerson('bo'))).map((cluster) => cluster.id);
    expect(bo).toEqual(['provisioning-lunorica', 'mine']);
    const operator = (await service.getAll(principalOf({ id: 'op', roles: ['operator'] }, { role: 'combined' }))).map((cluster) => cluster.id);
    expect(operator).toEqual(['provisioning-lunorica']);
  });
});

describe('aborting a cluster', () => {
  it('stops the workflow that provisions it once a bridge is set', async () => {
    const { service, db, infra } = setup();
    const bridge = mock<Pick<TemporalBridge, 'terminateWorkflow'>>();
    bridge.terminateWorkflow.mockResolvedValue(true);
    service.setTemporalBridge(bridge);
    infra.getLogPath.mockReturnValue('/tmp/abort.log');
    await db.infrastructure.saveCluster(k3d('c1', 'provisioning', { temporalWorkflowId: 'wf-1' }));
    await service.abort('c1', asPerson('bo'));
    await vi.waitFor(async () => expect(await db.infrastructure.getClusters()).toEqual([]));
    expect(bridge.terminateWorkflow).toHaveBeenCalledWith('wf-1', 'User aborted cluster provisioning');
    expect(infra.deleteLocalCluster).toHaveBeenCalled();
  });
});

describe('the kubeconfig a deleted cluster leaves', () => {
  const own = () => {
    const kube = join(homedir(), '.kube');
    mkdirSync(kube, { recursive: true });
    writeFileSync(join(kube, 'config'), 'the operator keeps every cluster here');
    return join(kube, 'config');
  };

  it('removes the file it wrote for a cluster it aborts, and nothing of the operator\'s', async () => {
    const { service, db, infra, kubeconfigDir } = setup();
    const operators = own();
    infra.getLogPath.mockReturnValue('/tmp/abort.log');
    await db.infrastructure.saveCluster(k3d('gpu', 'provisioning', { gpuEnabled: true }));
    writeFileSync(join(kubeconfigDir, 'kubeconfig-gpu'), 'written for it');
    await service.abort('gpu', asPerson('bo'));
    await vi.waitFor(async () => expect(await db.infrastructure.getClusters()).toEqual([]));
    expect(existsSync(join(kubeconfigDir, 'kubeconfig-gpu'))).toBe(false);
    expect(readFileSync(operators, 'utf8')).toBe('the operator keeps every cluster here');
  });
});

describe('Koala\'s own cluster when Koala runs on one of the person\'s machines', () => {
  const desk: ClusterMetadata = { id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'desk' };

  it('is that machine\'s cluster, the one record, running while Koala is on it and reached from Koala\'s own pods', async () => {
    const { db, infra, service, kubeconfigDir } = setup({ koalaMachineId: 'desk' });
    infra.runKubectl.mockResolvedValue(NODES);
    await db.infrastructure.saveCluster(desk);
    await db.infrastructure.saveCluster({ ...desk, id: 'machine-nas', name: 'nas', machineId: 'nas' });
    const own = await service.getSystemClusterEntry();
    expect(own).toMatchObject({ id: 'machine-desk', provider: 'machine', status: 'healthy', isSystem: true, machineId: 'desk' });
    expect((await service.reconcileAllClusters()).map((cluster) => cluster.id)).toEqual(['machine-desk', 'machine-nas']);
    for (const id of ['machine-desk', 'provisioning-lunorica']) expect((await service.getByIdUnscoped(id))?.id).toBe('machine-desk');
    expect(service.isKoalasCluster('machine-desk')).toBe(true);
    expect(service.isKoalasCluster('machine-nas')).toBe(false);
    const reached = await service.getKubeconfigPath(own);
    expect(reached).toBe(join(kubeconfigDir, 'kubeconfig-koala'));
    expect(readFileSync(reached, 'utf8')).toContain('server: https://kubernetes.default.svc:443');
    expect(readFileSync(reached, 'utf8')).toContain('tokenFile: /sa/token');
  });

  it('is still the fixed entry where Koala names no machine', async () => {
    const { service } = setup({ koalaMachineId: undefined });
    expect(await service.getSystemClusterEntry()).toMatchObject({ id: 'provisioning-lunorica', isSystem: true });
    expect(service.isKoalasCluster('machine-desk')).toBe(false);
  });
});
