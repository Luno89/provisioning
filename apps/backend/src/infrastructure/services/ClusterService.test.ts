import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mockFn } from 'vitest-mock-extended';
import { asPerson, principalOf, type ClusterMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { Shell } from '../lib/shell.js';
import { ClusterService } from './ClusterService.js';
import { testClusterAccess } from '../testing/cluster-access.js';

const MASTER = 'cluster-service-test-key';
const NODES = JSON.stringify({ items: [{ metadata: { labels: {} }, status: { allocatable: { cpu: '8', memory: '32Gi', 'nvidia.com/gpu': '1' } } }] });
const machine = (id: string, extra: Partial<ClusterMetadata> = {}): ClusterMetadata => ({ id, name: id, provider: 'machine', machineId: id, status: 'stopped', ownerId: 'bo', ...extra });

interface Places { shell?: Shell; koalaMachineId?: string | undefined; poolName?: string | undefined; root?: boolean | undefined; instanceOwnerId?: string | undefined }

function setup(places: Places = { koalaMachineId: 'desk', instanceOwnerId: 'bo' }) {
  const noHostTools = mockFn<Shell>();
  noHostTools.mockRejectedValue(new Error('not on this host'));
  const db: Database = memoryDatabase();
  const kubectl = vi.fn<(args: readonly string[]) => Promise<string>>();
  kubectl.mockRejectedValue(new Error('no nodes here'));
  const folder = mkdtempSync(join(tmpdir(), 'cluster-service-'));
  const access = testClusterAccess(db, { answers: kubectl, dataKey: MASTER, folder, koalaMachineId: places.koalaMachineId, poolName: places.poolName, root: places.root, serviceAccount: { host: 'kubernetes.default.svc', port: '443', caFile: '/sa/ca.crt', tokenFile: '/sa/token' } });
  return { db, kubectl, folder, service: new ClusterService(db, access, { shell: places.shell ?? noHostTools, instanceOwnerId: places.instanceOwnerId }) };
}

describe('the cluster this Koala runs in, read with its capacity', () => {
  it('is its machine\'s record, running while Koala is on it, with the capacity its nodes report', async () => {
    const { service, kubectl, db } = setup();
    await db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'desk' });
    kubectl.mockResolvedValue(NODES);
    expect(await service.ownCluster()).toMatchObject({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'healthy', ownerId: 'bo', capacity: { cpuCores: 8, ramGb: 32, gpuCount: 1, gpuVendor: 'nvidia' } });
  });

  it('adds the VRAM nvidia-smi reports when the nodes do not label it', async () => {
    const shell = mockFn<Shell>();
    shell.calledWith('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits').mockResolvedValue({ stdout: '24576\n', stderr: '' });
    const { service, kubectl } = setup({ shell, koalaMachineId: 'desk', instanceOwnerId: 'bo' });
    kubectl.mockResolvedValue(NODES);
    expect((await service.ownCluster())?.capacity).toMatchObject({ gpuVramMib: 24576 });
  });

  it('shows its capacity without VRAM when nvidia-smi does not answer, and without capacity when its nodes cannot be read', async () => {
    const shell = mockFn<Shell>();
    shell.mockRejectedValue(new Error('nvidia-smi: not found'));
    const { service, kubectl } = setup({ shell, koalaMachineId: 'desk', instanceOwnerId: 'bo' });
    kubectl.mockResolvedValue(NODES);
    expect((await service.ownCluster())?.capacity).not.toHaveProperty('gpuVramMib');
    kubectl.mockRejectedValue(new Error('refused'));
    const without = await service.ownCluster();
    expect(without?.status).toBe('healthy');
    expect(without?.capacity).toBeUndefined();
  });

  it('is its machine\'s cluster, the instance owner\'s, before the machine has reported it', async () => {
    const { service } = setup();
    expect(await service.ownCluster()).toMatchObject({ id: 'machine-desk', name: 'machine-desk', provider: 'machine', machineId: 'desk', ownerId: 'bo', status: 'healthy' });
  });

  it('is its place on Koala\'s servers for a pool instance, the instance owner\'s', async () => {
    const { service } = setup({ poolName: 'bob', instanceOwnerId: 'bo' });
    expect(await service.ownCluster()).toMatchObject({ id: 'pool-bob', name: 'pool-bob', provider: 'pool', ownerId: 'bo', status: 'healthy' });
    expect(service.isKoalasCluster('pool-bob')).toBe(true);
  });

  it('is root\'s own on root, nobody\'s', async () => {
    const own = await setup({ root: true }).service.ownCluster();
    expect(own).toMatchObject({ id: 'root', name: 'root', provider: 'root', status: 'healthy' });
    expect(own).not.toHaveProperty('ownerId');
  });

  it('is none where Koala was named neither its machine nor its pool place, and no id is taken for it', async () => {
    const { service } = setup({});
    expect(await service.ownCluster()).toBeUndefined();
    expect(service.ownClusterId()).toBeUndefined();
    expect(service.isKoalasCluster('provisioning-lunorica')).toBe(false);
  });
});

describe('the clusters a person owns', () => {
  it('are the cluster Koala runs in when they own this instance, then their own records, and never someone else\'s', async () => {
    const { service, db } = setup();
    await db.infrastructure.saveCluster({ id: 'machine-nas', name: 'nas', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'nas' });
    await db.infrastructure.saveCluster({ id: 'machine-other', name: 'other', provider: 'machine', status: 'stopped', ownerId: 'cy', machineId: 'other' });
    expect((await service.clustersOwnedBy('bo')).map((cluster) => cluster.id)).toEqual(['machine-desk', 'machine-nas']);
    expect((await service.clustersOwnedBy('cy')).map((cluster) => cluster.id)).toEqual(['machine-other']);
  });
});

describe('getAll', () => {
  it('shows each person only the clusters they own, the cluster Koala runs in to the instance\'s owner alone', async () => {
    const { service, db } = setup();
    await db.infrastructure.saveCluster(machine('mine', { ownerId: 'bo' }));
    await db.infrastructure.saveCluster(machine('theirs', { ownerId: 'someone-else' }));
    expect((await service.getAll(asPerson('bo'))).map((cluster) => cluster.id)).toEqual(['machine-desk', 'mine']);
    expect((await service.getAll(asPerson('someone-else'))).map((cluster) => cluster.id)).toEqual(['theirs']);
    const operator = (await service.getAll(principalOf({ id: 'op', roles: ['operator'] }, { role: 'root' }))).map((cluster) => cluster.id);
    expect(operator).toEqual([]);
  });

  it('lists the cluster Koala runs in first, once, then the person\'s machine clusters as stored', async () => {
    const { service, db } = setup();
    await db.infrastructure.saveCluster(machine('machine-nas'));
    await db.infrastructure.saveCluster(machine('machine-desk', { name: 'desk', machineId: 'desk' }));
    await db.infrastructure.saveCluster(machine('machine-attic'));
    expect((await service.getAll(asPerson('bo'))).map((cluster) => cluster.id)).toEqual(['machine-desk', 'machine-nas', 'machine-attic']);
  });
});

describe('Koala\'s own cluster when Koala runs on one of the person\'s machines', () => {
  const desk: ClusterMetadata = { id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', ownerId: 'bo', machineId: 'desk' };

  it('is that machine\'s cluster, the one record, running while Koala is on it and reached from Koala\'s own pods', async () => {
    const { db, kubectl, service, folder } = setup();
    kubectl.mockResolvedValue(NODES);
    await db.infrastructure.saveCluster(desk);
    await db.infrastructure.saveCluster({ ...desk, id: 'machine-nas', name: 'nas', machineId: 'nas' });
    const own = await service.ownCluster();
    expect(own).toMatchObject({ id: 'machine-desk', provider: 'machine', status: 'healthy', machineId: 'desk' });
    expect((await service.getAll(asPerson('bo'))).map((cluster) => cluster.id)).toEqual(['machine-desk', 'machine-nas']);
    expect((await service.getByIdUnscoped('machine-desk'))?.status).toBe('healthy');
    expect(await service.getByIdUnscoped('provisioning-lunorica')).toBeUndefined();
    expect(service.isKoalasCluster('machine-desk')).toBe(true);
    expect(service.isKoalasCluster('machine-nas')).toBe(false);
    const reached = await service.access.kubeconfigOf(own!.id);
    expect(reached).toBe(join(folder, 'kubeconfig-koala'));
    expect(readFileSync(reached, 'utf8')).toContain('server: https://kubernetes.default.svc:443');
    expect(readFileSync(reached, 'utf8')).toContain('tokenFile: /sa/token');
  });
});
