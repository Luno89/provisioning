import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { allowed, type Principal } from '../../platform/lib/permissions.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAsEnv, instancesRouter } from './instances.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { InstanceService, hashCredential } from '../services/InstanceService.js';
import { PoolMonitoringService } from '../services/PoolMonitoringService.js';

describe('what the installer sources', () => {
  it('reads back every value exactly in a POSIX shell, whatever characters it holds', () => {
    const bundle = {
      instanceId: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: "-----BEGIN PUBLIC KEY-----\nab'c$(rm -rf /)\n-----END PUBLIC KEY-----",
      meshLoginServer: 'https://mesh.example.com', preAuthKey: "key'with`quotes`", registry: '100.64.0.1:5001', image: '100.64.0.1:5001/nowrinkles/app',
      imageTag: 'abc', chartUrl: 'https://app.example.com/api/instances/chart.tgz', credential: 'c$HOME', name: 'luno', domain: 'example.com',
    };
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'join.env'), bundleAsEnv(bundle));

    const out = execFileSync('sh', ['-c', '. ./join.env; printf "%s\\n%s\\n%s" "$MESH_PREAUTH_KEY" "$INSTANCE_CREDENTIAL" "$(printf "%s" "$ROOT_PUBLIC_KEYS_B64" | base64 -d)"'], { cwd: dir, encoding: 'utf8' });

    expect(out.split('\n').slice(0, 2)).toEqual([bundle.preAuthKey, bundle.credential]);
    expect(out.split('\n').slice(2).join('\n')).toBe(bundle.rootPublicKeys);
  });
});

describe('trying Koala on its own servers', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('offers the pool to someone signed in, and starts their trial instance under the name they pick', async () => {
    const started: string[] = [];
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => instancesRouter({
        instances: new InstanceService(db, {
          rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev',
          pool: { slots: 1, trialDays: 14 },
        }, undefined, () => new Date('2026-10-20T00:00:00Z'), () => {}, { start: async (instanceId) => { started.push(instanceId); }, trialChanged: async () => {}, remove: async () => {} }),
        chart: async () => '',
        operatorOnly: (req: Request, res: Response, next: NextFunction) => (allowed((req as unknown as { principal: Principal }).principal, 'manage-accounts', { kind: 'install' }) ? next() : res.status(403).json({ error: 'Admin only' })),
      }),
    });
    const call = (method: 'get' | 'post', path: string, data?: unknown) => axios.request({ method, url: harness!.url(path), data, validateStatus: () => true });

    expect((await call('get', '/api/instances/pool')).data).toEqual({ available: true, trialDays: 14 });
    expect((await call('post', '/api/instances/pool', { name: 'no-dashes' })).status).toBe(400);
    const made = await call('post', '/api/instances/pool', { name: 'alice' });
    expect(made.status).toBe(202);
    expect(made.data).toMatchObject({ name: 'alice', trialEndsAt: '2026-11-03T00:00:00.000Z' });
    expect(started).toHaveLength(1);
    expect((await call('get', '/api/instances/mine')).data.instance).toMatchObject({ status: 'installing', name: 'alice', trialEndsAt: '2026-11-03T00:00:00.000Z' });
  });

  it('shows the pool and its trials only to an admin', async () => {
    harness = await mountRouter({
      prefix: '/api/instances',
      user: { ...TEST_USER },
      router: (db) => instancesRouter({
        instances: new InstanceService(db, {
          rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev',
          pool: { slots: 1, trialDays: 14 },
        }, undefined, () => new Date('2026-10-20T00:00:00Z'), () => {}, { start: async () => {}, trialChanged: async () => {}, remove: async () => {} }),
        chart: async () => '',
        operatorOnly: (req: Request, res: Response, next: NextFunction) => (allowed((req as unknown as { principal: Principal }).principal, 'manage-accounts', { kind: 'install' }) ? next() : res.status(403).json({ error: 'Admin only' })),
      }),
    });
    const call = (method: 'get' | 'put', path: string, data?: unknown) => axios.request({ method, url: harness!.url(path), data, validateStatus: () => true });
    expect((await call('get', '/api/instances/pool/admin')).status).toBe(403);
    expect((await call('put', '/api/instances/pool/admin/trial-days', { days: 30 })).status).toBe(403);
    harness.setUser({ ...TEST_USER, isAdmin: true } as typeof TEST_USER);
    expect((await call('put', '/api/instances/pool/admin/trial-days', { days: 30 })).data).toMatchObject({ trialDays: 30 });
    expect((await call('get', '/api/instances/pool/admin')).data).toMatchObject({ slots: 1, trialDays: 30, defaultTrialDays: 14, instances: [] });
  });
});

describe('a pool instance asking root about its own apps', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('answers only named questions about the instance\'s own place, to the instance\'s credential', async () => {
    const raw: string[] = [];
    const applied: string[] = [];
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => {
        void db.instances.saveInstance({
          id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret'),
          pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 'then', trialEndsAt: '2026-11-03T00:00:00.000Z' },
        } as never);
        return instancesRouter({
          instances: new InstanceService(db, {
            rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev',
            pool: { slots: 1, trialDays: 14 },
          }, undefined),
          chart: async () => '',
          operatorOnly: (_req: Request, res: Response) => { res.status(403).end(); },
          poolMonitoring: new PoolMonitoringService({
            kubectl: async (args) => {
              raw.push(args.join(' '));
              return JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1, '1'] }] } });
            },
            apply: async (manifest) => { applied.push(manifest); },
          }),
        });
      },
    });
    const as = (credential: string) => ({ 'x-instance-id': 'inst-1', authorization: `Bearer ${credential}` });
    const call = (method: 'post' | 'put', path: string, data: unknown, credential = 'secret') =>
      axios.request({ method, url: harness!.url(path), data, headers: as(credential), validateStatus: () => true });

    const answered = await call('post', '/api/instances/monitoring/ask', { ask: { kind: 'app', question: 'up', subject: { namespace: 'shop' } } });
    expect(answered.data).toEqual({ samples: [{ metric: {}, value: 1 }] });
    expect(decodeURIComponent(raw[0]!)).toContain('probe_success{namespace="pool-alice",koala_namespace="shop"}');
    expect((await call('post', '/api/instances/monitoring/ask', { ask: { kind: 'query', query: 'up' } })).status).toBe(400);
    expect((await call('post', '/api/instances/monitoring/ask', { ask: { kind: 'cluster', question: 'nodes' } }, 'wrong')).status).toBe(401);
    expect((await call('put', '/api/instances/monitoring/rules/r1', { namespace: 'shop', spec: { kind: 'down' }, summary: 'Shop is down' })).data).toEqual({ set: 'r1' });
    expect(JSON.parse(applied[0]!).metadata.namespace).toBe('pool-alice');
    expect((await call('put', '/api/instances/monitoring/rules/r2', { namespace: 'shop', spec: { kind: 'errors' }, summary: 's' })).status).toBe(400);
  });
});

describe('an instance keeping the groups its shared projects are addressed under', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('checks, claims and frees a group with the instance\'s credential', async () => {
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => {
        void db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret') });
        return instancesRouter({
          instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev' }, undefined),
          chart: async () => '',
        });
      },
    });
    const call = (method: 'get' | 'put' | 'delete', path: string, data?: unknown, credential = 'secret') =>
      axios.request({ method, url: harness!.url(path), data, headers: { 'x-instance-id': 'inst-1', authorization: `Bearer ${credential}` }, validateStatus: () => true });

    expect((await call('get', '/api/instances/groups/check?name=acme')).data).toEqual({ ok: true });
    expect((await call('get', '/api/instances/groups/check?name=alice')).data).toEqual({ ok: false, problem: '"alice" is taken' });
    expect((await call('put', '/api/instances/groups', { projectId: 'p1', name: 'acme' })).data).toEqual({ projectId: 'p1', name: 'acme' });
    expect((await call('put', '/api/instances/groups', { projectId: 'p2', name: 'acme' })).status).toBe(409);
    expect((await call('put', '/api/instances/groups', { projectId: 'p2', name: 'other' }, 'wrong')).status).toBe(401);
    expect((await call('delete', '/api/instances/groups/p1')).data).toEqual({ released: true });
    expect((await call('put', '/api/instances/groups', { projectId: 'p2', name: 'acme' })).status).toBe(200);
  });
});

describe('the new machine reading a moving instance through root', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('streams each part from the pool instance to the move\'s own credential, and to nobody else', async () => {
    const opened: string[] = [];
    let moveCredential = '';
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: async (db) => {
        await db.instances.saveInstance({
          id: 'inst-1', ownerId: TEST_USER.id, name: 'alice', status: 'ready', url: 'https://alice.koala.dev', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('pool-secret'),
          pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 'then', trialEndsAt: '2026-11-03T00:00:00.000Z' },
        });
        const instances = new InstanceService(db, {
          rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh', registry: 'r', imageTag: 't', domain: 'koala.dev',
        }, { createPreAuthKey: async () => ({ key: 'k' }) }, () => new Date('2026-10-20T00:00:00Z'), () => {}, {
          start: async () => {}, trialChanged: async () => {}, remove: async () => {}, move: async () => {}, moveFinished: async () => {}, moveStopped: async () => {},
        });
        const started = await instances.startMove(TEST_USER.id);
        if (!started.ok) throw new Error(started.error);
        const joined = await instances.join(started.value.token, 'desk');
        if (!joined.ok) throw new Error(joined.error);
        moveCredential = joined.value.credential;
        return instancesRouter({
          instances, chart: async () => '', operatorOnly: (_req: Request, res: Response) => { res.status(403).end(); },
          moveRelay: { open: async (source: { name: string }, part: string) => {
            opened.push(`${source.name}/${part}`);
            const { Readable } = await import('node:stream');
            if (part === 'gitea-db') {
              const broken = new Readable({ read() {} });
              broken.push('the first half');
              setTimeout(() => broken.destroy(new Error('aborted')), 50);
              return Object.assign(broken, { statusCode: 200, headers: { 'content-type': 'application/octet-stream' } });
            }
            return Object.assign(Readable.from([`the ${part} of ${source.name}`]), { statusCode: 200, headers: { 'content-type': 'application/gzip' } });
          } } as never,
        });
      },
    });
    const read = (part: string, credential: string) => axios.get(harness!.url(`/api/instances/move/parts/${part}`), {
      headers: { 'x-instance-id': 'inst-1', authorization: `Bearer ${credential}` }, validateStatus: () => true, responseType: 'text',
    });
    const mongo = await read('mongo', moveCredential);
    expect(mongo.status).toBe(200);
    expect(mongo.data).toBe('the mongo of alice');
    expect(mongo.headers['content-type']).toBe('application/gzip');
    expect((await read('mongo', 'pool-secret')).status).toBe(401);
    expect((await read('everything', moveCredential)).status).toBe(404);
    await expect(read('gitea-db', moveCredential)).rejects.toThrow();
    expect(opened).toEqual(['alice/mongo', 'alice/gitea-db']);
  });
});

describe('an instance\'s updates on root', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('answers the instance\'s check-in by its own setting, and serves each release\'s chart', async () => {
    const charts = mkdtempSync(join(tmpdir(), 'release-charts-'));
    writeFileSync(join(charts, 'old111.tgz'), 'old chart');
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => {
        void db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret'), running: 'new222', previous: 'old111' });
        return instancesRouter({
          instances: new InstanceService(db, {
            rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222', domain: 'koala.dev',
            releases: {
              releases: async () => [
                { imageTag: 'old111', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' },
                { imageTag: 'new222', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z' },
              ],
              hasChart: (imageTag) => imageTag === 'old111',
            },
          }, undefined),
          chart: async () => '',
          chartOf: (imageTag) => (imageTag === 'old111' ? join(charts, 'old111.tgz') : undefined),
        });
      },
    });
    const call = (method: 'get' | 'put', path: string, data?: unknown, credential = 'secret') =>
      axios.request({ method, url: harness!.url(path), data, headers: { 'x-instance-id': 'inst-1', authorization: `Bearer ${credential}` }, validateStatus: () => true });

    expect((await call('get', '/api/instances/updates')).data).toMatchObject({ auto: true, running: 'new222', target: 'new222' });
    expect((await call('put', '/api/instances/updates', { version: 'v2026.10.24' })).data).toMatchObject({ auto: false, picked: 'old111', target: 'old111' });
    expect((await call('get', '/api/instances/release')).data).toEqual({ imageTag: 'old111', chartUrl: 'https://app.koala.dev/api/instances/chart/old111.tgz' });
    expect((await call('get', '/api/instances/chart/old111.tgz')).data).toBe('old chart');
    expect((await call('get', '/api/instances/chart/nothing.tgz')).status).toBe(404);
    expect((await call('get', '/api/instances/updates', undefined, 'wrong')).status).toBe(401);
    expect((await call('put', '/api/instances/updates', { auto: 'yes' })).status).toBe(400);
  });
});
