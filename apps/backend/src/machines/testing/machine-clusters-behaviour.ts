import { beforeEach, describe, expect, it } from 'vitest';
import { decryptValue } from '../../platform/lib/crypto.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { DeploymentMetadata } from '../../platform/lib/types.js';
import { MachineClusters } from '../services/MachineClusters.js';

export function machineClustersBehaviour(make: () => Promise<Database>): void {
  const KEY = 'machine-clusters-key';
  const DESK = { id: 'desk', ownerId: 'bo', name: 'desk', meshIp: '100.64.0.7' };
  const app = (id: string, clusterId = 'machine-desk'): DeploymentMetadata => ({ id, name: id, clusterId, ownerId: 'bo', strategy: 'native', status: 'running' });

  let db: Database;
  let clusters: MachineClusters;

  beforeEach(async () => {
    db = await make();
    clusters = new MachineClusters({ store: db.infrastructure, accounts: db.accounts, dataKey: KEY, now: () => new Date('2026-11-05T12:00:00Z') });
  });

  const stored = async () => (await db.infrastructure.getClusters()).find((cluster) => cluster.id === 'machine-desk');

  describe('a machine\'s own cluster', () => {
    it('is recorded, stopped, the first time the machine says it has k3s, and only once', async () => {
      await clusters.reported(DESK, 'stopped');
      await clusters.reported(DESK, 'running');
      expect(await stored()).toMatchObject({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'stopped', machineId: 'desk', ownerId: 'bo', meshIp: '100.64.0.7' });
      expect((await db.infrastructure.getClusters()).filter((cluster) => cluster.provider === 'machine')).toHaveLength(1);
    });

    it('keeps the GPUs the machine reports and the problems it had reading them, made or already there, and leaves them when a report says nothing of GPUs', async () => {
      const rtx = { vendor: 'nvidia' as const, model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true };
      await clusters.reported(DESK, 'stopped', { gpus: [rtx], problems: [], withoutDriver: [] });
      expect(await stored()).toMatchObject({ gpus: [rtx], gpuProblems: [] });
      await clusters.reported(DESK, 'running', { gpus: [], problems: ['nvidia-smi is installed but does not answer'], withoutDriver: [] });
      expect(await stored()).toMatchObject({ gpus: [], gpuProblems: ['nvidia-smi is installed but does not answer'] });
      await clusters.reported(DESK, 'running');
      expect(await stored()).toMatchObject({ gpus: [], gpuProblems: ['nvidia-smi is installed but does not answer'] });
    });

    it('keeps the cores and memory the machine reports, with the GPUs pods can be given there, and leaves them when a report says nothing of them', async () => {
      const rtx = { vendor: 'nvidia' as const, model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true };
      await clusters.reported(DESK, 'stopped', { gpus: [rtx], problems: [], withoutDriver: [] }, { cpuCores: 16, memoryMiB: 65536 });
      expect((await stored())?.capacity).toEqual({ cpuCores: 16, ramGb: 64, gpuCount: 2, gpuVendor: 'nvidia' });
      await clusters.reported(DESK, 'running', { gpus: [{ ...rtx, runtime: false }], problems: [], withoutDriver: [] }, { cpuCores: 16, memoryMiB: 65536 });
      expect((await stored())?.capacity).toEqual({ cpuCores: 16, ramGb: 64 });
      await clusters.reported(DESK, 'running');
      expect((await stored())?.capacity).toEqual({ cpuCores: 16, ramGb: 64 });
    });

    it('is not recorded for a machine without k3s, and goes when k3s does, unless apps are still on it', async () => {
      await clusters.reported(DESK, 'absent');
      expect(await stored()).toBeUndefined();
      await clusters.reported(DESK, 'stopped');
      await db.infrastructure.saveDeployment(app('shop'));
      await clusters.reported(DESK, 'absent');
      expect(await stored()).toBeDefined();
      await db.infrastructure.deleteDeployment('shop');
      await clusters.reported(DESK, 'absent');
      expect(await stored()).toBeUndefined();
    });

    it('keeps the kubeconfig the machine handed over sealed once it started, and is marked stopped when it stops', async () => {
      await clusters.reported(DESK, 'stopped');
      await clusters.started('machine-desk', { state: 'running', meshIp: '100.64.0.8', kubeconfig: 'server: https://100.64.0.8:6443' });
      const started = (await stored())!;
      expect(started).toMatchObject({ status: 'healthy', meshIp: '100.64.0.8', lastSyncedAt: '2026-11-05T12:00:00.000Z' });
      expect(JSON.stringify(started)).not.toContain('server: https');
      expect(decryptValue(started.kubeconfigEnc!, KEY)).toBe('server: https://100.64.0.8:6443');
      await clusters.stopped('machine-desk');
      expect((await stored())?.status).toBe('stopped');
    });

    it('takes the time from the clock when it is given none', async () => {
      const unclocked = new MachineClusters({ store: db.infrastructure, accounts: db.accounts, dataKey: KEY });
      const before = Date.now();
      await unclocked.reported(DESK, 'stopped');
      await unclocked.started('machine-desk', { state: 'running', meshIp: DESK.meshIp, kubeconfig: 'k' });
      const record = (await stored())!;
      expect(Date.parse(record.createdAt!)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(record.lastSyncedAt!)).toBeGreaterThanOrEqual(before);
    });

    it('refuses a start of a cluster it does not know or one that did not come up', async () => {
      await expect(clusters.started('machine-nobody', { state: 'running', meshIp: 'x', kubeconfig: 'y' })).rejects.toThrow('machine-nobody is not a machine\'s cluster this Koala knows');
      await clusters.reported(DESK, 'stopped');
      await expect(clusters.started('machine-desk', { state: 'absent' })).rejects.toThrow('desk\'s cluster answered absent when it was started');
    });

    it('is idle once no app but the one leaving is on it', async () => {
      await db.infrastructure.saveDeployment(app('shop'));
      await db.infrastructure.saveDeployment(app('elsewhere', 'other-cluster'));
      expect(await clusters.idle('machine-desk')).toBe(false);
      expect(await clusters.idle('machine-desk', 'shop')).toBe(true);
      await db.infrastructure.saveDeployment(app('blog'));
      expect(await clusters.idle('machine-desk', 'shop')).toBe(false);
    });

    it('is never idle while Koala runs on it, apps or none', async () => {
      const holding = new MachineClusters({ store: db.infrastructure, accounts: db.accounts, dataKey: KEY, koalaMachineId: 'desk' });
      expect(await holding.idle('machine-desk')).toBe(false);
      expect(await holding.idle('machine-nas')).toBe(true);
    });

    it('is forgotten with its apps\' records when the machine is removed, leaving other clusters\' apps, and a model of it is nobody\'s default any more', async () => {
      await clusters.reported(DESK, 'stopped');
      await db.infrastructure.saveDeployment(app('shop'));
      await db.infrastructure.saveDeployment(app('elsewhere', 'other-cluster'));
      await db.accounts.saveUser({ id: 'bo', email: 'bo@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-11-01T00:00:00Z', defaultModelId: 'shop' });
      await db.accounts.saveUser({ id: 'cy', email: 'cy@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-11-01T00:00:00Z', defaultModelId: 'elsewhere' });
      await clusters.forget(DESK);
      expect(await stored()).toBeUndefined();
      expect((await db.infrastructure.getDeployments()).map((deployment) => deployment.id)).toEqual(['elsewhere']);
      expect((await db.accounts.getUserById('bo'))?.defaultModelId).toBeUndefined();
      expect((await db.accounts.getUserById('cy'))?.defaultModelId).toBe('elsewhere');
      await clusters.forget(DESK);
    });
  });
}
