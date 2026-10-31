import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { allowed, type Principal } from '../../platform/lib/permissions.js';
import { MailReputation } from '../../platform/services/MailReputation.js';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAsEnv, instancesRouter } from './instances.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { InstanceService, hashCredential } from '../services/InstanceService.js';
import { PoolMonitoringService } from '../services/PoolMonitoringService.js';

describe('what the installer reads from root', () => {
  const installer = readFileSync(join(process.cwd(), '../../scripts/instance/install.sh'), 'utf8');
  const reader = /^read_joined\(\) \{[\s\S]*?^\}$/m.exec(installer)![0];
  const bundle = {
    instanceId: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: "-----BEGIN PUBLIC KEY-----\nab'c$(touch ran)\n-----END PUBLIC KEY-----",
    meshLoginServer: 'https://mesh.example.com', preAuthKey: "key'with`touch ran`", registry: '100.64.0.1:5001', image: '100.64.0.1:5001/nowrinkles/app',
    imageTag: 'abc', chartUrl: 'https://app.example.com/api/instances/chart.tgz', credential: "c$HOME'$(touch ran)", name: 'luno', domain: 'example.com',
  };
  const readIn = (dir: string, print: string) => spawnSync('sh', ['-c', `die() { echo "refused: $1"; exit 1; }\n${reader}\nread_joined ./join.env\n${print}`], { cwd: dir, encoding: 'utf8' });

  it('reads back every value exactly, whatever characters it holds, and runs none of them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'join.env'), bundleAsEnv(bundle));
    const read = readIn(dir, 'printf "%s\\n%s\\n%s" "$MESH_PREAUTH_KEY" "$INSTANCE_CREDENTIAL" "$(printf "%s" "$ROOT_PUBLIC_KEYS_B64" | base64 -d)"');
    expect(read.status, read.stdout + read.stderr).toBe(0);
    expect(read.stdout.split('\n').slice(0, 2)).toEqual([bundle.preAuthKey, bundle.credential]);
    expect(read.stdout.split('\n').slice(2).join('\n')).toBe(bundle.rootPublicKeys);
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  it('refuses a reply missing a value it needs, or holding a line it cannot read', () => {
    const missing = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(missing, 'join.env'), bundleAsEnv({ ...bundle, credential: '' }));
    expect(readIn(missing, 'true').stdout).toMatch(/refused: root's join reply has no INSTANCE_CREDENTIAL/);
    const unquoted = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(unquoted, 'join.env'), `${bundleAsEnv(bundle)}INSTANCE_ID=$(touch ran)\n`);
    expect(readIn(unquoted, 'true').stdout).toMatch(/refused: root's join reply has a line this installer cannot read/);
    expect(existsSync(join(unquoted, 'ran'))).toBe(false);
  });

  it('never sources the reply, and hands the mesh key to Tailscale in a file', () => {
    expect(installer).not.toMatch(/^\s*\.\s+"?\$JOIN_ENV/m);
    expect(installer).toMatch(/--auth-key="file:\$MESH_KEY_FILE"/);
    expect(installer).not.toMatch(/--authkey "\$MESH_PREAUTH_KEY"/);
  });
});

describe('what the installer tells root as it installs', () => {
  const installer = readFileSync(join(process.cwd(), '../../scripts/instance/install.sh'), 'utf8');
  const fn = (name: string) => new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm').exec(installer)![0];
  const reporting = ['json_string', 'report_body', 'send_report', 'report', 'report_failure'].map(fn).join('\n');
  let harness: Harness | undefined;
  let rootDown: http.Server | undefined;
  afterEach(async () => {
    await harness?.close();
    await new Promise((resolve) => (rootDown ? rootDown.close(resolve) : resolve(undefined)));
    rootDown = undefined;
  });

  async function rootWithAnInstance() {
    let service: InstanceService | undefined;
    harness = await mountRouter({
      prefix: '/api/instances',
      router: (db) => {
        const mesh = { createPreAuthKey: async () => ({ key: 'mesh-key' }), listUserDevices: async () => [{ ipAddresses: ['100.64.0.9'] }] };
        service = new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev' }, mesh);
        return instancesRouter({ instances: service, chart: async () => '', operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() });
      },
    });
    const made = await service!.createJoinToken(TEST_USER.id, 'luno');
    if (!made.ok) throw new Error(made.error);
    const joined = await service!.join(made.value.token, 'box');
    if (!joined.ok) throw new Error(joined.error);
    return { credential: joined.value.credential, instanceId: joined.value.instanceId, record: async () => (await harness!.db.instances.getInstances()).find((entry) => entry.id === joined.value.instanceId)! };
  }

  function installerReports(calls: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const bin = mkdtempSync(join(tmpdir(), 'installer-bin-'));
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const child = spawn('sh', ['-c', `set -eu\ndie() { echo "refused: $1"; exit 1; }\n${reporting}\n${calls.join('\n')}\necho finished`], { env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    return new Promise((resolve) => child.on('close', (status) => resolve({ status, stdout, stderr })));
  }

  it('reaches root at every step, so root holds where it is, its mesh address, its url and what it runs', async () => {
    const root = await rootWithAnInstance();
    const ran = await installerReports([
      'report joined "On the mesh as 100.64.0.9"',
      'report installing "Installing the instance" "https://luno.koala.dev"',
      'report ready "Installed" "https://luno.koala.dev"',
    ], { ROOT_URL: harness!.url(''), INSTANCE_ID: root.instanceId, INSTANCE_CREDENTIAL: root.credential, MESH_IP: '100.64.0.9', INSTANCE_IMAGE_TAG: 'abc123' });
    expect(ran.stdout + ran.stderr).toContain('finished');
    expect(await root.record()).toMatchObject({ status: 'ready', detail: 'Installed', meshIp: '100.64.0.9', url: 'https://luno.koala.dev', running: 'abc123' });
  });

  it('sends any words root can read, quotes, backslashes and new lines included', async () => {
    const root = await rootWithAnInstance();
    const ran = await installerReports([`report installing 'it said "no" at C:\\path
and stopped'`], { ROOT_URL: harness!.url(''), INSTANCE_ID: root.instanceId, INSTANCE_CREDENTIAL: root.credential });
    expect(ran.stdout + ran.stderr).toContain('finished');
    expect((await root.record()).detail).toBe('it said "no" at C:\\path and stopped');
  });

  it('stops the install with root\'s reason when root refuses a report', async () => {
    const root = await rootWithAnInstance();
    const ran = await installerReports(['report joined "On the mesh as 100.64.0.9"'], { ROOT_URL: harness!.url(''), INSTANCE_ID: root.instanceId, INSTANCE_CREDENTIAL: 'not-the-credential', MESH_IP: '100.64.0.9' });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('refused: root refused this machine\'s report that it is joined (401): {"error":"unknown instance or credential"}');
    expect(ran.stdout).not.toContain('finished');
  });

  it('sends a report again while root is not answering it, and stops asking once root takes it', async () => {
    const root = await rootWithAnInstance();
    let tries = 0;
    rootDown = http.createServer((req, res) => {
      tries += 1;
      if (tries < 3) { res.writeHead(503); res.end('restarting'); return; }
      const forwarded = http.request(harness!.url(req.url ?? ''), { method: req.method, headers: req.headers }, (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
      req.pipe(forwarded);
    });
    await new Promise<void>((resolve) => rootDown!.listen(0, '127.0.0.1', resolve));
    const ran = await installerReports(['report joined "On the mesh as 100.64.0.9"'], { ROOT_URL: `http://127.0.0.1:${(rootDown.address() as AddressInfo).port}`, INSTANCE_ID: root.instanceId, INSTANCE_CREDENTIAL: root.credential, MESH_IP: '100.64.0.9' });
    expect(ran.stdout).toContain('root did not take this machine\'s report that it is joined (503); sending it again');
    expect(ran.stdout).toContain('finished');
    expect(tries).toBe(3);
    expect(await root.record()).toMatchObject({ status: 'joined', meshIp: '100.64.0.9' });
  });

  it('tells root the install stopped without waiting on a root that does not answer', async () => {
    const ran = await installerReports(['report_failure "The install command stopped on this machine; run it again to retry"'], { ROOT_URL: 'http://127.0.0.1:9', INSTANCE_ID: 'inst-x', INSTANCE_CREDENTIAL: 'c' });
    expect(ran.stderr).toContain('root did not take the report that the install stopped (000)');
    expect(ran.stdout).toContain('finished');
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
    harness.setUser({ ...TEST_USER, roles: ['operator' as const] } as typeof TEST_USER);
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

  it('after root rolled back: points an instance on auto at root\'s release, shows the withdrawn one, and refuses picking it', async () => {
    const withdrawn = { at: '2026-10-26T00:00:00.000Z', by: 'root rolled back to v2026.10.24' };
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => {
        void db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret'), running: 'new222', previous: 'old111' });
        return instancesRouter({
          instances: new InstanceService(db, {
            rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'old111', domain: 'koala.dev',
            releases: {
              releases: async () => [
                { imageTag: 'old111', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' },
                { imageTag: 'new222', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', withdrawn },
              ],
              hasChart: () => false,
            },
          }, undefined),
          chart: async () => '',
          chartOf: () => undefined,
        });
      },
    });
    const call = (method: 'get' | 'put', path: string, data?: unknown) =>
      axios.request({ method, url: harness!.url(path), data, headers: { 'x-instance-id': 'inst-1', authorization: 'Bearer secret' }, validateStatus: () => true });

    expect((await call('get', '/api/instances/release')).data).toMatchObject({ imageTag: 'old111' });
    const view = (await call('get', '/api/instances/updates')).data as { target: string; runningWithdrawn?: unknown; releases: Array<{ imageTag: string; withdrawn?: unknown; choosable: boolean }> };
    expect(view.target).toBe('old111');
    expect(view.runningWithdrawn).toEqual(withdrawn);
    expect(view.releases.find((row) => row.imageTag === 'new222')).toMatchObject({ withdrawn, choosable: false });
    const picked = await call('put', '/api/instances/updates', { version: 'v2026.10.25' });
    expect(picked.status).toBe(409);
    expect(picked.data.error).toBe('v2026.10.25 was withdrawn when root rolled back to v2026.10.24; pick another release');
  });
});

describe('Koala\'s dependencies on root', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  const watch = {
    view: async () => ({ findings: [], check: { checkedAt: '2026-10-29T00:00:00.000Z', releases: [], components: [], problems: [] } }),
    check: async () => ({ findings: [] }),
    forRelease: async (imageTag: string) => ({ release: imageTag === 'new222' ? 'v2026.10.25' : imageTag, findings: [{ component: { name: 'seroval', version: '1.6.7', kind: 'npm' as const }, advisory: { id: 'GHSA-x' }, state: 'due' as const, fix: '1.6.8', fixedBy: 'v2026.10.29' }] }),
  };

  const mount = async (operator: boolean) => mountRouter({
    prefix: '/api/instances',
    user: { ...TEST_USER, ...(operator ? { roles: ['operator'] } : {}) },
    router: async (db) => {
      await db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret'), running: 'new222' });
      return instancesRouter({
        instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222' }, undefined),
        chart: async () => '',
        administers: (req: Request, res: Response, next: NextFunction) => (allowed((req as unknown as { principal: Principal }).principal, 'administer', { kind: 'install' }) ? next() : res.status(403).json({ error: 'Only the operator of this server can do that.' })),
        dependencies: watch,
      });
    },
  });

  it('shows the findings and runs the check only for the operator', async () => {
    harness = await mount(false);
    expect((await axios.get(harness.url('/api/instances/dependencies'), { validateStatus: () => true })).status).toBe(403);
    expect((await axios.post(harness.url('/api/instances/dependencies/check'), {}, { validateStatus: () => true })).status).toBe(403);
    await harness.close();
    harness = await mount(true);
    const seen = await axios.get(harness.url('/api/instances/dependencies'), { validateStatus: () => true });
    expect(seen.status).toBe(200);
    expect(seen.headers['cache-control']).toBe('no-store');
    expect(seen.data.check.checkedAt).toBe('2026-10-29T00:00:00.000Z');
    expect((await axios.post(harness.url('/api/instances/dependencies/check'), {}, { validateStatus: () => true })).status).toBe(200);
  });

  it('tells an instance, by its credential, what the release it runs carries and what fixes it', async () => {
    harness = await mount(false);
    const ask = (credential: string) => axios.get(harness!.url('/api/instances/release-findings'), { headers: { 'x-instance-id': 'inst-1', authorization: `Bearer ${credential}` }, validateStatus: () => true });
    const answer = await ask('secret');
    expect(answer.data).toMatchObject({ release: 'v2026.10.25', findings: [{ advisory: { id: 'GHSA-x' }, fixedBy: 'v2026.10.29' }] });
    expect((await ask('wrong')).status).toBe(401);
  });
});

describe('root\'s mail on its admin page', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  const mount = async (operator: boolean, mailReputation?: MailReputation) => mountRouter({
    prefix: '/api/instances',
    user: { ...TEST_USER, ...(operator ? { roles: ['operator'] } : {}) },
    router: async (db) => instancesRouter({
      instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222' }, undefined),
      chart: async () => '',
      administers: (req: Request, res: Response, next: NextFunction) => (allowed((req as unknown as { principal: Principal }).principal, 'administer', { kind: 'install' }) ? next() : res.status(403).json({ error: 'Only the operator of this server can do that.' })),
      ...(mailReputation ? { mailReputation } : {}),
    }),
  });

  it('shows the operator what root found about its mail and checks again on asking', async () => {
    let lookups = 0;
    const reputation = new MailReputation({
      domain: 'koala.dev',
      resolve4: async (name) => {
        lookups += 1;
        if (name === 'mail.koala.dev') return ['203.0.113.7'];
        if (name.startsWith('2.0.0.127.')) return ['127.0.0.2'];
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      },
      reverse: async () => ['mail.koala.dev.'],
      reach25: async () => ({ ok: true }),
    });
    harness = await mount(false, reputation);
    expect((await axios.get(harness.url('/api/instances/mail-reputation'), { validateStatus: () => true })).status).toBe(403);
    expect((await axios.post(harness.url('/api/instances/mail-reputation/check'), {}, { validateStatus: () => true })).status).toBe(403);
    expect(lookups).toBe(0);
    await harness.close();
    harness = await mount(true, reputation);
    const started = await axios.post(harness.url('/api/instances/mail-reputation/check'), {}, { validateStatus: () => true });
    expect(started.status).toBe(202);
    await reputation.check();
    const seen = await axios.get(harness.url('/api/instances/mail-reputation'), { validateStatus: () => true });
    expect(seen.headers['cache-control']).toBe('no-store');
    expect(seen.data).toMatchObject({ checking: false, report: { problems: [], lines: expect.arrayContaining([{ mark: 'ok', said: '203.0.113.7 reverses to mail.koala.dev' }]), check: { ip: '203.0.113.7', reverseDns: { state: 'matches' }, blocklists: [{ state: 'clear' }, { state: 'clear' }, { state: 'clear' }] } } });
  });

  it('says so where this server sends no mail itself', async () => {
    harness = await mount(true);
    expect((await axios.get(harness.url('/api/instances/mail-reputation'), { validateStatus: () => true })).status).toBe(404);
  });
});
