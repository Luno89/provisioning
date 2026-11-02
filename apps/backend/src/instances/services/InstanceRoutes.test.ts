import { describe, expect, it, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Database } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { InstanceRoutes, type CaddyControl } from './InstanceRoutes.js';
import type { InstanceRecord } from '../lib/instances.js';

const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);

const record = (patch: Partial<InstanceRecord>): InstanceRecord => ({ id: 'inst-1', ownerId: 'u1', url: '', createdAt: 'x', updatedAt: 'x', name: 'luno', meshIp: '100.64.0.7', status: 'ready', ...patch });

let db: Database;
let dir: string;
let reloads: number;
let served: string | undefined;
let log: string;
let routes: InstanceRoutes;

beforeEach(async () => {
  db = memoryDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-'));
  reloads = 0;
  served = undefined;
  log = '';
  const caddy: CaddyControl = {
    reload: async () => { reloads += 1; },
    certificateFor: async (serverName) => (serverName === 'koala-probe.luno.koala.dev' ? served : undefined),
    recentLog: async () => log,
  };
  routes = new InstanceRoutes(db.instances, 'koala.dev', dir, caddy);
});

describe('root\'s routes to instances', () => {
  it('writes a ready instance\'s routes once, reloading only when they change, and removes them when it goes', async () => {
    await db.instances.saveInstance(record({}));
    await routes.sync();
    expect(await fs.readFile(path.join(dir, 'instances', 'luno.caddy'), 'utf8')).toContain('host luno.koala.dev');
    expect(reloads).toBe(1);
    await routes.sync();
    expect(reloads).toBe(1);
    await db.instances.deleteInstance('inst-1');
    await routes.sync();
    expect(await fs.readdir(path.join(dir, 'instances'))).toEqual([]);
    expect(reloads).toBe(2);
  });

  it('reloads again on every pass after a reload fails, though the files no longer change, and once on starting', async () => {
    await db.instances.saveInstance(record({}));
    let refusing = true;
    const attempts: boolean[] = [];
    const flaky = new InstanceRoutes(db.instances, 'koala.dev', dir, {
      reload: async () => { attempts.push(refusing); if (refusing) throw new Error('Caddy is restarting'); },
      certificateFor: async () => undefined,
      recentLog: async () => '',
    });
    await expect(flaky.sync()).rejects.toThrow('Caddy is restarting');
    await expect(flaky.sync()).rejects.toThrow('Caddy is restarting');
    refusing = false;
    await flaky.sync();
    await flaky.sync();
    expect(attempts).toEqual([true, true, false]);
    await routes.sync();
    expect(reloads).toBe(1);
  });

  it('marks nested addresses ready once Caddy serves their certificate, and says why while it does not', async () => {
    await db.instances.saveInstance(record({ addresses: { nested: true, state: 'issuing' } }));
    log = JSON.stringify({ level: 'error', identifier: '*.luno.koala.dev', error: 'rateLimited: too many certificates' });
    await routes.sync();
    expect(await fs.readFile(path.join(dir, 'instance-sites', 'luno.caddy'), 'utf8')).toMatch(/^\*\.luno\.koala\.dev/);
    expect((await db.instances.getInstances())[0]!.addresses).toMatchObject({ state: 'issuing', detail: matching(/weekly limit/) });
    served = 'DNS:*.luno.koala.dev';
    await routes.sync();
    expect((await db.instances.getInstances())[0]!.addresses).toEqual({ nested: true, state: 'ready' });
  });
});

describe('root\'s routes running on their own', () => {
  it('syncs when changed, once at a time, and again if asked meanwhile', async () => {
    await db.instances.saveInstance(record({}));
    routes.changed();
    routes.changed();
    await routes.settled();
    expect(reloads).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(path.join(dir, 'instances', 'luno.caddy'), 'utf8')).toContain('host luno.koala.dev');
  });

  it('logs a failed pass rather than throwing it', async () => {
    const messages: string[] = [];
    const failing = new InstanceRoutes(db.instances, 'koala.dev', dir, { reload: async () => { throw new Error('Caddy is restarting'); }, certificateFor: async () => undefined, recentLog: async () => '' }, (message) => messages.push(message));
    await db.instances.saveInstance(record({}));
    failing.changed();
    await failing.settled();
    expect(messages).toEqual(['instance routes: Caddy is restarting']);
  });

  it('syncs on a timer once started, until stopped', async () => {
    vi.useFakeTimers();
    try {
      await db.instances.saveInstance(record({}));
      routes.start(1000);
      await vi.advanceTimersByTimeAsync(2500);
      await routes.settled();
      routes.stop();
      const before = reloads;
      await db.instances.saveInstance(record({ name: 'two', id: 'inst-2', ownerId: 'u2' }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(reloads).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves nested addresses alone that another pass already settled', async () => {
    await db.instances.saveInstance(record({ addresses: { nested: true, state: 'issuing' } }));
    served = 'DNS:*.luno.koala.dev';
    await routes.sync();
    const first = (await db.instances.getInstances())[0]!;
    expect(first.addresses).toEqual({ nested: true, state: 'ready' });
    await routes.sync();
    expect((await db.instances.getInstances())[0]!.updatedAt).toBe(first.updatedAt);
  });

  it('says it could not read Caddy\'s log and carries on', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await db.instances.saveInstance(record({ addresses: { nested: true, state: 'issuing' } }));
      const unreadable = new InstanceRoutes(db.instances, 'koala.dev', dir, { reload: async () => undefined, certificateFor: async () => undefined, recentLog: async () => { throw new Error('no such container'); } });
      await unreadable.sync();
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('no such container'));
    } finally {
      warned.mockRestore();
    }
  });
});
