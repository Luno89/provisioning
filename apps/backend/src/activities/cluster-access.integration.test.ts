import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { MongoDB } from '../platform/lib/mongo-db.js';
import { CheckWorkloadActivity } from './CheckWorkloadActivity.js';
import { DestroyAppActivity } from './DestroyAppActivity.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';

const CLUSTER = `machine-${randomUUID().slice(0, 8)}`;
const NOWHERE = 'https://127.0.0.1:1';
const HANDED = `apiVersion: v1\nkind: Config\nclusters:\n- name: desk\n  cluster:\n    server: ${NOWHERE}\n    insecure-skip-tls-verify: true\ncontexts:\n- name: desk\n  context:\n    cluster: desk\n    user: desk\ncurrent-context: desk\nusers:\n- name: desk\n  user:\n    token: t\n`;
const before = process.env.MONGO_URI;
let db: MongoDB;

beforeAll(async () => {
  process.env.MONGO_URI = `${inject('mongoUri')}t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db = new MongoDB({ MONGO_URI: process.env.MONGO_URI });
  await db.init();
  await db.infrastructure.saveCluster({ id: CLUSTER, name: 'desk', provider: 'machine', status: 'healthy', machineId: 'desk', ownerId: 'bo', createdAt: new Date().toISOString() } as never);
});

afterAll(async () => {
  await db.close();
  if (before === undefined) delete process.env.MONGO_URI; else process.env.MONGO_URI = before;
  rmSync(join(tmpdir(), `handed-kubeconfig-${CLUSTER}`), { force: true });
});

describe('cluster steps on a machine\'s cluster use the kubeconfig the workflow handed them', () => {
  it('reads the workload through it', async () => {
    const read = await CheckWorkloadActivity({ name: 'shop', namespace: 'shop', clusterId: CLUSTER, kubeconfig: HANDED });
    expect(read.health).toBe('unknown');
    expect(read.reason).toContain('127.0.0.1:1');
  }, 60_000);

  it('removes an app through it', async () => {
    await expect(DestroyAppActivity({
      name: 'shop', namespace: 'shop', deploymentId: 'shop', clusterId: CLUSTER, clusterName: 'desk', provider: 'machine', strategy: 'native',
      appType: ODOO_PROJECT_APP, logFile: join(tmpdir(), `destroy-${CLUSTER}.log`), kubeconfig: HANDED,
    } as never)).rejects.toThrow(/127\.0\.0\.1:1/);
  }, 60_000);
});
