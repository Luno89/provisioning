import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { InstanceRoutes, type CaddyControl } from './InstanceRoutes.js';
import type { InstanceRecord } from '../lib/instances.js';

const record = (patch: Partial<InstanceRecord>): InstanceRecord => ({ id: 'inst-1', ownerId: 'u1', url: '', createdAt: 'x', updatedAt: 'x', name: 'luno', meshIp: '100.64.0.7', status: 'ready', ...patch });

let db: MongoDB;
let dir: string;
let reloads: number;
let served: string | undefined;
let log: string;
let routes: InstanceRoutes;

beforeEach(async () => {
  db = await testDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-'));
  reloads = 0;
  served = undefined;
  log = '';
  const caddy: CaddyControl = {
    reload: async () => { reloads += 1; },
    certificateFor: async (serverName) => (serverName === 'koala-probe.luno.koala.dev' ? served : undefined),
    recentLog: async () => log,
  };
  routes = new InstanceRoutes(db, 'koala.dev', dir, caddy);
});

describe('root\'s routes to instances', () => {
  it('writes a ready instance\'s routes once, reloading only when they change, and removes them when it goes', async () => {
    await db.saveInstance(record({}));
    await routes.sync();
    expect(await fs.readFile(path.join(dir, 'instances', 'luno.caddy'), 'utf8')).toContain('host luno.koala.dev');
    expect(reloads).toBe(1);
    await routes.sync();
    expect(reloads).toBe(1);
    await db.deleteInstance('inst-1');
    await routes.sync();
    expect(await fs.readdir(path.join(dir, 'instances'))).toEqual([]);
    expect(reloads).toBe(2);
  });

  it('marks nested addresses ready once Caddy serves their certificate, and says why while it does not', async () => {
    await db.saveInstance(record({ addresses: { nested: true, state: 'issuing' } }));
    log = JSON.stringify({ level: 'error', identifier: '*.luno.koala.dev', error: 'rateLimited: too many certificates' });
    await routes.sync();
    expect(await fs.readFile(path.join(dir, 'instance-sites', 'luno.caddy'), 'utf8')).toMatch(/^\*\.luno\.koala\.dev/);
    expect((await db.getInstances())[0]!.addresses).toMatchObject({ state: 'issuing', detail: expect.stringMatching(/weekly limit/) });
    served = 'DNS:*.luno.koala.dev';
    await routes.sync();
    expect((await db.getInstances())[0]!.addresses).toEqual({ nested: true, state: 'ready' });
  });
});
