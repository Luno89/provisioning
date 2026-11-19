import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest';
import { MOVE_IN_ID } from '../infrastructure/index.js';
import { CLUSTER_TOOL_PATHS } from '../infrastructure/index.js';
import { leaseMongo } from '../platform/lib/mongo-lease.js';
import { TEST_DATA_KEY, testDatabaseAt } from '../platform/lib/test-database.js';
import { moveMongo, restoreMongoInto } from './move-import.js';

const run = promisify(execFile);
const started: MongoMemoryServer[] = [];
afterEach(async () => { for (const server of started.splice(0)) await server.stop(); });

const k3s = inject('k3s');
const admin = join(mkdtempSync(join(tmpdir(), 'koala-move-mongo-')), 'admin.yaml');
writeFileSync(admin, k3s.admin, { mode: 0o600 });
const NAMESPACE = `move-mongo-${randomUUID().slice(0, 8)}`;
const kubectl = async (args: string[], input?: Readable): Promise<string> => {
  const child = run(CLUSTER_TOOL_PATHS.kubectl, ['--kubeconfig', admin, ...args]);
  if (input) input.pipe(child.child.stdin!);
  return (await child).stdout;
};
afterAll(async () => { await kubectl(['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait=true']); }, 0);

const lines = (docs: Array<{ c: string; d: Record<string, unknown> }>): string => docs.map((line) => `${JSON.stringify(line)}\n`).join('');
const stateSecret = (suffix: string) => ({
  apiVersion: 'v1', kind: 'Secret', type: 'Opaque', data: { tfstate: Buffer.from(suffix).toString('base64') },
  metadata: { name: `tfstate-default-${suffix}`, labels: { tfstate: 'true', tfstateSecretSuffix: suffix, tfstateWorkspace: 'default', 'app.kubernetes.io/managed-by': 'terraform' } },
});

describe('the move\'s Mongo step on the new machine', () => {
  it('restores what root carried into this machine\'s Mongo and leaves no connection open', async () => {
    const { db, uri, dbName } = await testDatabaseAt();
    const carried = lines([{ c: 'projects', d: { _id: 'p1', id: 'p1', name: 'Shop', ownerId: 'bo', createdAt: 't' } }]);
    const said: string[] = [];
    expect(await restoreMongoInto({ uri, dbName }, Readable.from([zlib.gzipSync(carried)]), (line) => said.push(line))).toBe(1);
    expect((await db.projects.getProjects()).map((project) => project.name)).toEqual(['Shop']);
    expect(said).toEqual([]);
  });

  it('waits for a Mongo whose replica set has no primary yet, as a new machine\'s first start has, and restores into it', async () => {
    const server = await MongoMemoryServer.create({ instance: { replSet: 'koala' } });
    started.push(server);
    const carried = `${JSON.stringify({ c: 'projects', d: { _id: 'p1', id: 'p1', name: 'Shop', ownerId: 'bo', createdAt: 't' } })}\n`;

    expect(await restoreMongoInto({ uri: server.getUri(), dbName: 'koala' }, Readable.from([zlib.gzipSync(carried)]), () => undefined)).toBe(1);

    const reader = await leaseMongo(server.getUri());
    try {
      expect((await reader.client.db('koala').collection<{ name: string }>('projects').find().toArray()).map((project) => project.name)).toEqual(['Shop']);
    } finally {
      await reader.release();
    }
  });

  it('renames the records and the apps\' Terraform state from the pool\'s cluster onto the machine\'s, on a real cluster, and keeps what is left to bring over', async () => {
    const { db, uri, dbName } = await testDatabaseAt();
    await kubectl(['create', 'namespace', NAMESPACE]);
    const carried = lines([
      { c: 'deployments', d: { _id: 'd1', id: 'd1', name: 'shop', clusterId: 'pool-shop', deploymentId: '40213377', strategy: 'helm', status: 'running', ownerId: 'bo' } },
      { c: 'deployments', d: { _id: 'd2', id: 'd2', name: 'lab-app', clusterId: 'machine-lab', deploymentId: '11111111', strategy: 'helm', status: 'running', ownerId: 'bo' } },
    ]);
    const state = [stateSecret('app-pool-shop-40213377-state'), stateSecret('app-machine-lab-11111111-state'), stateSecret('platform-gitea-state'), stateSecret('pool-shop-state'), stateSecret('pool-shop-observability-state')];
    const asked: string[] = [];
    const said: string[] = [];
    const parts = {
      async part(name: string) {
        asked.push(name);
        return Readable.from([name === 'mongo' ? zlib.gzipSync(carried) : JSON.stringify(state)]);
      },
    } as never;

    await moveMongo({
      target: { uri, dbName }, from: 'pool-shop', onto: 'machine-desk', ownerId: 'bo', namespace: NAMESPACE, dataKey: TEST_DATA_KEY,
      parts, kubectl, say: (line) => said.push(line), now: () => '2026-11-18T12:00:00.000Z',
    });

    expect(asked).toEqual(['mongo', 'terraform-state']);
    expect((await db.infrastructure.getDeployments()).map((deployment) => `${deployment.name} ${deployment.clusterId}`).sort()).toEqual(['lab-app machine-lab', 'shop machine-desk']);
    const secrets = JSON.parse(await kubectl(['get', 'secrets', '-n', NAMESPACE, '-l', 'tfstate=true', '-o', 'json'])) as { items: Array<{ metadata: { name: string; labels: Record<string, string> }; data: Record<string, string> }> };
    expect(secrets.items.map((secret) => `${secret.metadata.name} ${secret.metadata.labels.tfstateSecretSuffix}`).sort()).toEqual([
      'tfstate-default-app-machine-desk-40213377-state app-machine-desk-40213377-state',
      'tfstate-default-app-machine-lab-11111111-state app-machine-lab-11111111-state',
      'tfstate-default-platform-gitea-state platform-gitea-state',
    ]);
    expect(secrets.items.find((secret) => secret.metadata.name.includes('machine-desk'))?.data.tfstate).toBe(Buffer.from('app-pool-shop-40213377-state').toString('base64'));
    expect(await db.infrastructure.getMoveIn()).toEqual({ id: MOVE_IN_ID, ownerId: 'bo', from: 'pool-shop', onto: 'machine-desk', at: '2026-11-18T12:00:00.000Z' });
    expect(said).toContain('  3 stacks');
  }, 0);
});
