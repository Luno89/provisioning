import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import { allowed, type Principal } from '../../platform/lib/permissions.js';
import { MailReputation } from '../../platform/services/MailReputation.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instancesRouter } from './instances.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { InstanceService } from '../services/InstanceService.js';
import { testInstanceClients, tokenOfInstance } from '../testing/placed-koala.js';
import { WithdrawalNotices } from '../services/WithdrawalNotices.js';
import { MailService } from '../../platform/services/MailService.js';
import type { InstanceRelease } from '../lib/instance-updates.js';
import { SETUP_AGAIN_ASKED } from '@koala/engine-core/koala-install';

const TOKEN = tokenOfInstance('inst-1');

const servingReleases = (imageTag: string, releases: InstanceRelease[], hasChart: (imageTag: string) => boolean, chartOf: (imageTag: string) => string | undefined): Promise<Harness> => mountRouter({
  prefix: '/api/instances',
  user: TEST_USER,
  router: async (db) => {
    await db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', running: 'new222', previous: 'old111' });
    return instancesRouter({
      instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], ...testInstanceClients, registry: 'r', imageTag, domain: 'koala.dev', releases: { releases: async () => releases, hasChart } }, undefined),
      chart: async () => '',
      chartOf,
    });
  },
});

const asInstance = (harness: Harness) => (method: 'get' | 'put' | 'post', path: string, data?: unknown, token = TOKEN) =>
  axios.request<Record<string, unknown>>({ method, url: harness.url(path), data, headers: { 'x-instance-id': 'inst-1', authorization: `Bearer ${token}` }, validateStatus: () => true });

const including = (items: unknown[]): unknown => expect.arrayContaining(items);

describe('an instance keeping the groups its shared projects are addressed under', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('checks, claims and frees a group with the instance\'s credential', async () => {
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => instancesRouter({
        instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], ...testInstanceClients, registry: 'r', imageTag: 't', domain: 'koala.dev' }, undefined),
        chart: async () => '',
      }),
    });
    await harness.db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then' });
    const call = (method: 'get' | 'put' | 'delete', path: string, data?: unknown, credential = TOKEN) =>
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

describe('an instance\'s updates on root', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('answers the instance\'s check-in by its own setting, and serves each release\'s chart', async () => {
    const charts = mkdtempSync(join(tmpdir(), 'release-charts-'));
    writeFileSync(join(charts, 'old111.tgz'), 'old chart');
    harness = await servingReleases('new222', [
      { imageTag: 'old111', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' },
      { imageTag: 'new222', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z' },
    ], (imageTag) => imageTag === 'old111', (imageTag) => (imageTag === 'old111' ? join(charts, 'old111.tgz') : undefined));
    const call = asInstance(harness);

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
    harness = await servingReleases('old111', [
      { imageTag: 'old111', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' },
      { imageTag: 'new222', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', withdrawn },
    ], () => false, () => undefined);
    const call = asInstance(harness);

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
      await db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', running: 'new222' });
      return instancesRouter({
        instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], ...testInstanceClients, registry: 'r', imageTag: 'new222' }, undefined),
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
    const seen = await axios.get<{ check: { checkedAt: string } }>(harness.url('/api/instances/dependencies'), { validateStatus: () => true });
    expect(seen.status).toBe(200);
    expect(seen.headers['cache-control']).toBe('no-store');
    expect(seen.data.check.checkedAt).toBe('2026-10-29T00:00:00.000Z');
    expect((await axios.post(harness.url('/api/instances/dependencies/check'), {}, { validateStatus: () => true })).status).toBe(200);
  });

  it('after root rolled back below an instance\'s data: keeps it on what it runs, says why, and refuses a pick that cannot run its data', async () => {
    const withdrawn = { at: '2026-11-18T00:00:00.000Z', by: 'root rolled back to v2026.10.24' };
    harness = await servingReleases('old111', [
      { imageTag: 'old111', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' },
      { imageTag: 'new222', version: 'v2026.11.17', servedAt: '2026-11-17T00:00:00.000Z', dataVersion: 1, withdrawn },
    ], () => false, () => undefined);
    const call = asInstance(harness);

    expect((await call('post', '/api/instances/status', { status: 'ready', imageTag: 'new222', dataVersion: 1 })).status).toBe(200);
    expect((await call('get', '/api/instances/release')).data).toMatchObject({ imageTag: 'new222', dataVersion: 1 });
    expect((await call('get', '/api/instances/updates')).data).toMatchObject({ target: 'new222', heldByData: { version: 'v2026.10.24', needs: 1 } });
    const picked = await call('put', '/api/instances/updates', { version: 'v2026.10.24' });
    expect(picked.status).toBe(409);
    expect(picked.data.error).toBe('v2026.10.24 cannot run this instance\'s data: a later release moved it forward for good (data version 1), and v2026.10.24 knows only data version 0');
    expect((await call('post', '/api/instances/status', { status: 'ready', imageTag: 'new222', dataVersion: 0 })).status).toBe(200);
    expect((await call('get', '/api/instances/release')).data).toMatchObject({ imageTag: 'new222' });
    expect((await call('post', '/api/instances/status', { status: 'ready', dataVersion: 'one' })).status).toBe(400);
  });

  it('emails the owner once when a check-in brings data the release root runs cannot run', async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: async (db) => {
        await db.instances.recordRelease({ imageTag: 'old111', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' });
        await db.instances.recordRelease({ imageTag: 'new222', version: 'v2026.11.17', servedAt: '2026-11-17T00:00:00.000Z', dataVersion: 1 });
        await db.instances.withdrawRelease('new222', { at: '2026-11-18T00:00:00.000Z', by: 'root rolled back to v2026.10.24' });
        await db.instances.saveInstance({ id: 'inst-1', ownerId: 'u1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', running: 'new222', previous: 'old111' } as never);
        const mail = new MailService({
          way: { kind: 'smtp', url: 'smtp://x', from: 'Koala <alerts@koala.dev>' },
          emailOf: async (id) => (id === 'u1' ? 'alice@example.com' : undefined),
          transport: () => ({ sendMail: async (message) => { sent.push(message); } }),
        });
        return instancesRouter({
          instances: new InstanceService(db, {
            rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], ...testInstanceClients, registry: 'r', imageTag: 'old111', domain: 'koala.dev',
            releases: { releases: () => db.instances.getReleases(), hasChart: () => false },
            notices: new WithdrawalNotices(db.instances, mail, 'old111'),
          }, undefined),
          chart: async () => '',
          chartOf: () => undefined,
        });
      },
    });
    const report = (dataVersion: number) => axios.post(harness!.url('/api/instances/status'), { status: 'ready', imageTag: 'new222', dataVersion }, { headers: { 'x-instance-id': 'inst-1', authorization: `Bearer ${TOKEN}` }, validateStatus: () => true });
    expect((await report(0)).status).toBe(200);
    expect(sent).toEqual([]);
    expect((await report(1)).status).toBe(200);
    expect(sent).toMatchObject([{ to: 'alice@example.com', subject: 'alice stays on its release' }]);
    expect((await report(1)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('tells an instance, by its credential, what the release it runs carries and what fixes it', async () => {
    harness = await mount(false);
    const ask = (credential: string) => axios.get(harness!.url('/api/instances/release-findings'), { headers: { 'x-instance-id': 'inst-1', authorization: `Bearer ${credential}` }, validateStatus: () => true });
    const answer = await ask(TOKEN);
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
      instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], ...testInstanceClients, registry: 'r', imageTag: 'new222' }, undefined),
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
    expect(seen.data).toMatchObject({ checking: false, report: { problems: [], lines: including([{ mark: 'ok', said: '203.0.113.7 reverses to mail.koala.dev' }]), check: { ip: '203.0.113.7', reverseDns: { state: 'matches' }, blocklists: [{ state: 'clear' }, { state: 'clear' }, { state: 'clear' }] } } });
  });

  it('says so where this server sends no mail itself', async () => {
    harness = await mount(true);
    expect((await axios.get(harness.url('/api/instances/mail-reputation'), { validateStatus: () => true })).status).toBe(404);
  });
});

describe('a Koala whose setup stopped, set up again from root', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  const stoppedAtGitea = { revision: 4, state: 'failed' as const, stage: 'gitea', title: 'Gitea, your repositories and images', why: 'the volume is full', at: 'then' };
  const install = { id: 'install-1', machineId: 'desk', state: 'failed' as const, revision: 4, at: 'then' };

  it('lets only its owner ask, tells the Koala, and follows the new attempt as the Koala reports it', async () => {
    const told: [string, string][] = [];
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => instancesRouter({
        instances: new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], ...testInstanceClients, registry: 'r', imageTag: 't', domain: 'koala.dev', connected: () => true, tell: (instanceId, event) => { told.push([instanceId, event]); } }, undefined),
        chart: async () => '',
      }),
    });
    await harness.db.instances.saveInstance({ id: 'inst-1', ownerId: TEST_USER.id, name: 'alice', machine: 'desk', status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: the volume is full', url: '', createdAt: 'then', updatedAt: 'then', install, setup: stoppedAtGitea });
    await harness.db.instances.saveInstance({ id: 'inst-2', ownerId: 'someone-else', name: 'bob', machine: 'lab', status: 'failed', url: '', createdAt: 'then', updatedAt: 'then', install, setup: stoppedAtGitea });
    const person = (method: 'get' | 'post', path: string) => axios.request<Record<string, unknown>>({ method, url: harness!.url(path), validateStatus: () => true });
    const call = asInstance(harness);

    expect((await person('get', '/api/instances/mine')).data).toMatchObject({ instance: { status: 'failed', setupAgain: 'stopped' }, can: ['set-up-again'] });

    const theirs = await person('post', '/api/instances/inst-2/setup-again');
    expect(theirs.status).toBe(404);
    expect(theirs.data).toEqual({ error: 'Koala not found' });
    expect(told).toEqual([]);

    const asked = await person('post', '/api/instances/inst-1/setup-again');
    expect(asked.status).toBe(202);
    expect(asked.data).toMatchObject({ status: 'installing', detail: 'Asking Koala on desk to set itself up again from Gitea, your repositories and images', setupAgain: 'asked' });
    expect(told).toEqual([['inst-1', SETUP_AGAIN_ASKED]]);
    expect((await call('get', '/api/instances/setup-again')).data).toEqual({ asked: true });
    expect((await call('get', '/api/instances/setup-again', undefined, 'wrong')).status).toBe(401);

    expect((await call('post', '/api/instances/status', { provision: { revision: 4, progress: { stage: 'gitea', title: 'Gitea, your repositories and images', state: 'started', line: 'waiting for gitea-0' } } })).status).toBe(200);
    expect((await call('get', '/api/instances/setup-again')).data).toEqual({ asked: false });
    expect((await person('get', '/api/instances/mine')).data).toMatchObject({ instance: { status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for gitea-0' }, can: [] });
    expect((await person('post', '/api/instances/inst-1/setup-again')).data).toEqual({ error: 'Koala on desk has not stopped setting itself up, so there is nothing to set up again' });

    expect((await call('post', '/api/instances/status', { provision: { revision: 4, progress: { stage: 'gitea', title: 'Gitea, your repositories and images', state: 'failed', why: 'the volume is still full' } } })).status).toBe(200);
    expect((await person('get', '/api/instances/mine')).data).toMatchObject({ instance: { status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: the volume is still full', setupAgain: 'stopped' }, can: ['set-up-again'] });
  });
});
