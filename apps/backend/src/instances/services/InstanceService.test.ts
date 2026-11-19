import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { InstanceService, JOIN_TOKEN_TTL_SECONDS, hashCredential, instanceIdFor } from './InstanceService.js';
import { InstanceReach } from './InstanceReach.js';
import type { InstanceRecord } from '../lib/instances.js';
import { koalaPlacedAndUp } from '../testing/placed-koala.js';

const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
const containing = (text: string): unknown => expect.stringContaining(text);

const settings = {
  rootUrl: 'https://app.example.com',
  rootPublicKeys: () => ['PEM-1'],
  meshLoginServer: 'https://mesh.example.com',
  registry: '100.64.0.1:5001',
  imageTag: 'abc123',
  domain: 'koala.dev',
  siteNames: ['app', 'mesh'],
};
const removedNodes: { ownerId: string; meshIp: string }[] = [];
const mesh = { createPreAuthKey: async (ownerId: string) => ({ key: `pre-${ownerId}` }), removeNode: async (ownerId: string, meshIp: string) => { removedNodes.push({ ownerId, meshIp }); } };

let db: Database;
let now: Date;
let service: InstanceService;
let routeChanges: number;

const placedFor = async (ownerId: string, name: string = 'luno', on: InstanceService = service) =>
  koalaPlacedAndUp(on, db, ownerId, { id: `m-${ownerId}`, name: 'm', meshIp: '100.64.0.9' }, name);

const tokenFor = async (ownerId: string, name: string = 'luno') => {
  const made = await service.createJoinToken(ownerId, name);
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

beforeEach(async () => {
  db = memoryDatabase();
  now = new Date('2026-10-02T12:00:00Z');
  routeChanges = 0;
  service = new InstanceService(db, settings, mesh, () => now, () => { routeChanges += 1; });
});

describe('bringing a user\'s own machine in as their instance', () => {
  it('gives the owner a one-line command, and the machine everything it needs, once', async () => {
    const { token, command } = await tokenFor('u1');
    expect(command).toBe(`curl -fsSL https://app.example.com/install.sh | sudo sh -s -- ${token}`);
    expect(await service.mine('u1')).toMatchObject({ id: instanceIdFor('u1'), status: 'waiting' });

    const joined = await service.join(token, 'luno-desktop');
    expect(joined).toMatchObject({ ok: true, value: {
      instanceId: instanceIdFor('u1'), ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: 'PEM-1',
      meshLoginServer: 'https://mesh.example.com', preAuthKey: 'pre-u1', registry: '100.64.0.1:5001',
      image: '100.64.0.1:5001/nowrinkles/app', imageTag: 'abc123', chartUrl: 'https://app.example.com/api/instances/chart.tgz',
      name: 'luno', domain: 'koala.dev',
    } });
    expect(await service.mine('u1')).toMatchObject({ status: 'joined' });
    expect(await service.join(token, 'again')).toMatchObject({ ok: false, status: 401 });
  });

  it('names a person\'s Koala to their machines only once it is in service', async () => {
    expect(await service.koalaOf('u1')).toBeUndefined();
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'luno-desktop');
    if (!joined.ok) throw new Error(joined.error);
    expect(await service.koalaOf('u1')).toBeUndefined();
    await service.report(joined.value.instanceId, joined.value.credential, { status: 'ready', url: 'https://luno.koala.dev' });
    expect(await service.koalaOf('u1')).toEqual({ url: 'https://luno.koala.dev', audience: joined.value.instanceId });
    expect(await service.koalaOf('someone-else')).toBeUndefined();
  });

  it('refuses a join command that has expired', async () => {
    const { token } = await tokenFor('u1');
    now = new Date(now.getTime() + (JOIN_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(await new InstanceService(db, settings, mesh, () => now).join(token, 'late')).toMatchObject({ ok: false, status: 401 });
  });

  it('keeps the machine\'s credential only as a hash, and answers only to it', async () => {
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const id = joined.value.instanceId;

    const stored = (await db.instances.getInstances('u1'))[0]!;
    expect(stored.credentialHash).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(joined.value.credential);

    expect(await service.release(id, joined.value.credential)).toMatchObject({ ok: true, value: { imageTag: 'abc123' } });
    expect(await service.release(id, 'guess')).toMatchObject({ ok: false, status: 401 });
    expect(await service.release('inst-someone-else', joined.value.credential)).toMatchObject({ ok: false, status: 401 });
  });

  it('tells its owner\'s machines where their Koala is when a report brings it into service, as when it reached root still installing', async () => {
    const told: string[] = [];
    service = new InstanceService(db, { ...settings, serviceChanged: (instance) => { told.push(`${instance.ownerId}:${instance.status}`); } }, mesh, () => now, () => undefined);
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;

    await service.report(instanceId, credential, { status: 'installing', detail: 'installing Koala on this machine' });
    await service.report(instanceId, credential, { status: 'installing', detail: 'still installing' });
    await service.report(instanceId, credential, { status: 'ready', detail: 'Running dev' });
    await service.report(instanceId, credential, { status: 'ready', detail: 'Running dev' });

    expect(told).toEqual(['u1:installing', 'u1:ready']);
  });

  it('records what the machine reports, and where the instance answers', async () => {
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;

    expect(await service.report(instanceId, credential, { status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320/', meshIp: '100.64.0.7' })).toMatchObject({ ok: true });
    expect(await service.mine('u1')).toEqual({ id: instanceId, status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320', name: 'luno', watch: { notifyWhenUnreachable: true, alwaysTold: false } });
    expect(await service.report(instanceId, credential, { status: 'exploded' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.report(instanceId, credential, { status: 'ready', url: 'javascript:alert(1)' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.report(instanceId, credential, { status: 'ready', url: 'https://luno.koala.dev' })).toMatchObject({ ok: true, value: { url: 'https://luno.koala.dev' } });
  });

  it('never takes an address for the instance that root would call somewhere private, unless it is the instance\'s own mesh address', async () => {
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;
    await service.report(instanceId, credential, { status: 'ready', url: 'https://luno.koala.dev', meshIp: '100.64.0.7' });

    for (const url of ['http://127.0.0.1:3001', 'http://localhost:8080', 'http://10.0.0.5', 'http://169.254.169.254', 'http://100.64.0.8:30320', 'http://[::1]:3001', 'http://user:pw@luno.koala.dev']) {
      const refused = await service.report(instanceId, credential, { status: 'ready', url });
      expect(refused, url).toMatchObject({ ok: false, status: 400 });
    }
    expect(await service.report(instanceId, credential, { status: 'ready', url: 'http://127.0.0.1:3001' })).toMatchObject({ error: matching(/^root does not call http:\/\/127\.0\.0\.1:3001: .* is a private, loopback, mesh or reserved address\./) });
    expect(await service.report(instanceId, credential, { status: 'ready', url: 'http://100.64.0.7:30320' })).toMatchObject({ ok: true });
    expect((await service.mine('u1'))?.url).toBe('http://100.64.0.7:30320');
  });

  it('takes a public address only once it resolves to public addresses, and any address in a lab or on a dev box', async () => {
    const publicProblem = async (url: string) => (url.includes('rebound') ? 'rebound.example resolves to 10.0.0.1 is a private, loopback, mesh or reserved address' : undefined);
    const strict = new InstanceService(db, { ...settings, reach: new InstanceReach({ open: false, domain: 'koala.dev' }, { open: fetch, public: fetch, publicProblem, viaCaddy: async () => { throw new Error('nothing here goes through root\'s Caddy'); } }) }, mesh, () => now);
    const lab = new InstanceService(db, { ...settings, reach: new InstanceReach({ open: true, domain: 'koala.dev' }) }, mesh, () => now);
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;
    expect(await strict.report(instanceId, credential, { status: 'ready', url: 'https://box.example.org' })).toMatchObject({ ok: true, value: { url: 'https://box.example.org' } });
    expect(await strict.report(instanceId, credential, { status: 'ready', url: 'https://rebound.example' })).toMatchObject({ ok: false, status: 400 });
    expect(await lab.report(instanceId, credential, { status: 'ready', url: 'http://127.0.0.1:3001' })).toMatchObject({ ok: true, value: { url: 'http://127.0.0.1:3001' } });
  });

  it('stops watching an instance whose check-in comes from a release that never connects, and keeps one that is connected', async () => {
    const connected = new Set<string>();
    service = new InstanceService(db, { ...settings, connected: (id: string) => connected.has(id) }, mesh, () => now, () => undefined);
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;
    const instance = (await db.instances.getInstances()).find((entry) => entry.id === instanceId)!;
    await db.instances.savePresence(instance, true);

    await service.report(instanceId, credential, { status: 'ready', imageTag: 'v1', presence: true });
    expect((await db.instances.getWatch(instanceId))?.presence).toBe(true);
    connected.add(instanceId);
    await service.report(instanceId, credential, { status: 'ready', imageTag: 'v1' });
    expect((await db.instances.getWatch(instanceId))?.presence).toBe(true);
    connected.delete(instanceId);
    await service.report(instanceId, credential, { status: 'ready', imageTag: 'v0' });
    expect((await db.instances.getWatch(instanceId))?.presence).toBe(false);
  });

  it('will not let a machine join a root with no mesh or no registry', async () => {
    const { token } = await tokenFor('u1');
    const noRegistry = new InstanceService(db, { ...settings, registry: '' }, mesh, () => now);
    expect(await noRegistry.join(token, 'm')).toMatchObject({ ok: false, status: 503 });
  });
});

describe('an instance\'s name and addresses', () => {
  it('takes the name with Koala put on a machine, refusing a bad one, one taken, and a change', async () => {
    const desk = { id: 'm-u1', name: 'm', meshIp: '100.64.0.9' };
    const laptop = { id: 'm-u2', name: 'laptop', meshIp: '100.64.0.10' };
    expect(await service.placeOn('u1', desk, 'shop-x', 'install-a')).toMatchObject({ ok: false, status: 400, error: matching(/no dashes/) });
    expect(await service.placeOn('u1', desk, 'mesh', 'install-a')).toMatchObject({ ok: false, error: matching(/kept for the platform/) });
    expect(await service.placeOn('u1', desk, undefined, 'install-a')).toMatchObject({ ok: false, error: 'pick a name for your instance' });
    await placedFor('u1', 'luno');
    expect(await service.placeOn('u2', laptop, 'luno', 'install-b')).toMatchObject({ ok: false, error: '"luno" is taken' });
    expect(await service.nameCheck('u2', 'luno')).toEqual({ ok: false, problem: '"luno" is taken' });
    expect(await service.placeOn('u1', desk, 'other', 'install-c')).toMatchObject({ ok: false, error: matching(/already named "luno"/) });
    expect(await service.placeOn('u1', desk, undefined, 'install-c')).toMatchObject({ ok: true });
    expect((await db.instances.getInstances('u1'))[0]!.name).toBe('luno');
  });

  it('suggests a name from the person\'s email', async () => {
    await db.accounts.saveUser({ id: 'u3', email: 'sam.rivera@example.com' } as never);
    expect(await service.nameCheck('u3', undefined)).toEqual({ ok: false, suggestion: 'samrivera' });
    expect(await service.nameCheck('u3', 'samrivera')).toEqual({ ok: true, address: 'https://samrivera.koala.dev' });
  });

  it('keeps the mesh address the machine reports, and says the routes changed', async () => {
    const { instanceId, credential } = await placedFor('u1');
    expect(await service.report(instanceId, credential, { status: 'joined', meshIp: '100.64.0.9' })).toMatchObject({ ok: true, value: { meshIp: '100.64.0.9' } });
    expect(await service.report(instanceId, credential, { status: 'joined', meshIp: '100.64.0.9 { import x }' })).toMatchObject({ ok: false, status: 400 });
    const before = routeChanges;
    await service.report(instanceId, credential, { status: 'ready' });
    expect(routeChanges).toBe(before + 1);
  });

  it('takes a mesh address only when one of the owner\'s own machines on the mesh has it, keeping the one it had while the mesh cannot be asked', async () => {
    const devices: Record<string, string[]> = { u1: ['100.64.0.9'], u2: ['100.64.0.50'] };
    const checked = new InstanceService(db, settings, { ...mesh, listUserDevices: async (ownerId: string) => [{ ipAddresses: devices[ownerId] ?? [] }] }, () => now);
    const { instanceId, credential } = await placedFor('u1', 'luno', checked);
    expect(await checked.report(instanceId, credential, { status: 'joined', meshIp: '100.64.0.50' })).toEqual({ ok: false, status: 400, error: '100.64.0.50 is not one of this instance\'s owner\'s machines on the mesh' });
    expect(await checked.report(instanceId, credential, { status: 'joined', meshIp: '100.64.0.9' })).toMatchObject({ ok: true, value: { meshIp: '100.64.0.9' } });
    const down = new InstanceService(db, settings, { ...mesh, listUserDevices: async () => { throw new Error('headscale is down'); } }, () => now);
    expect(await down.report(instanceId, credential, { status: 'ready', meshIp: '100.64.0.10' })).toMatchObject({ ok: true, value: { status: 'ready', meshIp: '100.64.0.9' } });
  });

  it('turns nested addresses on as issuing, only for the instance itself', async () => {
    const { instanceId, credential } = await placedFor('u1');
    expect(await service.addresses(instanceId, credential)).toEqual({ ok: true, value: { nested: false, name: 'luno', domain: 'koala.dev' } });
    expect(await service.setAddresses(instanceId, credential, true)).toEqual({ ok: true, value: { nested: true, state: 'issuing', name: 'luno', domain: 'koala.dev' } });
    expect(await service.setAddresses(instanceId, 'guess', false)).toMatchObject({ ok: false, status: 401 });
    expect(await service.setAddresses(instanceId, credential, 'yes')).toMatchObject({ ok: false, status: 400 });
    expect(await new InstanceService(db, { ...settings, domain: undefined }, mesh, () => now).addresses(instanceId, credential)).toMatchObject({ ok: false, status: 503 });
  });
});

describe('the groups a shared project\'s apps are addressed under', () => {
  const joinedAs = (ownerId: string, name: string) => placedFor(ownerId, name);

  it('checks a name against the rules, every instance\'s name and every group anywhere on root', async () => {
    const luno = await joinedAs('u1', 'luno');
    await joinedAs('u2', 'sam');
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'acme')).toEqual({ ok: true, value: { ok: true } });
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'ac-me')).toMatchObject({ ok: true, value: { ok: false, problem: matching(/no dashes/) } });
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'mesh')).toMatchObject({ ok: true, value: { ok: false, problem: matching(/kept for the platform/) } });
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'app')).toMatchObject({ ok: true, value: { ok: false, problem: matching(/kept for the platform/) } });
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'sam')).toEqual({ ok: true, value: { ok: false, problem: '"sam" is taken' } });
    expect(await service.checkGroup(luno.instanceId, 'guess', 'acme')).toMatchObject({ ok: false, status: 401 });
  });

  it('claims a group for one project, again for the same project, and refuses it to any other project or instance', async () => {
    const luno = await joinedAs('u1', 'luno');
    const sam = await joinedAs('u2', 'sam');
    const before = routeChanges;
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p1', 'acme')).toEqual({ ok: true, value: { projectId: 'p1', name: 'acme' } });
    expect(routeChanges).toBe(before + 1);
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p1', 'acme')).toEqual({ ok: true, value: { projectId: 'p1', name: 'acme' } });
    expect(routeChanges).toBe(before + 1);
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p2', 'acme')).toEqual({ ok: false, status: 409, error: '"acme" is taken' });
    expect(await service.claimGroup(sam.instanceId, sam.credential, 'p1', 'acme')).toEqual({ ok: false, status: 409, error: '"acme" is taken' });
    expect(await service.checkGroup(sam.instanceId, sam.credential, 'acme')).toEqual({ ok: true, value: { ok: false, problem: '"acme" is taken' } });
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p1', 'other')).toMatchObject({ ok: false, status: 409, error: matching(/already addressed under "acme"/) });
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p3', 'sam')).toEqual({ ok: false, status: 409, error: '"sam" is taken' });
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p3', 'shop-x')).toMatchObject({ ok: false, status: 400 });
    expect(await service.claimGroup(luno.instanceId, luno.credential, '', 'shop')).toMatchObject({ ok: false, status: 400 });
    expect(await service.claimGroup(luno.instanceId, 'guess', 'p4', 'shop')).toMatchObject({ ok: false, status: 401 });
    expect(await service.placeOn('u3', { id: 'm-u3', name: 'm', meshIp: '100.64.0.11' }, 'acme', 'install-u3')).toMatchObject({ ok: false, error: '"acme" is taken' });
    expect((await db.instances.getInstances('u1'))[0]!.groups).toEqual([{ projectId: 'p1', name: 'acme' }]);
  });

  it('frees a group when its project is taken back, so another can have it', async () => {
    const luno = await joinedAs('u1', 'luno');
    const sam = await joinedAs('u2', 'sam');
    await service.claimGroup(luno.instanceId, luno.credential, 'p1', 'acme');
    const before = routeChanges;
    expect(await service.releaseGroup(luno.instanceId, luno.credential, 'p1')).toEqual({ ok: true, value: { released: true } });
    expect(routeChanges).toBe(before + 1);
    expect(await service.releaseGroup(luno.instanceId, luno.credential, 'p1')).toEqual({ ok: true, value: { released: false } });
    expect(routeChanges).toBe(before + 1);
    expect(await service.claimGroup(sam.instanceId, sam.credential, 'q1', 'acme')).toMatchObject({ ok: true });
    expect(await service.releaseGroup(sam.instanceId, 'guess', 'q1')).toMatchObject({ ok: false, status: 401 });
  });

  it('keeps an instance\'s groups when Koala is put on its machine again', async () => {
    const luno = await joinedAs('u1', 'luno');
    await service.claimGroup(luno.instanceId, luno.credential, 'p1', 'acme');
    expect(await service.placeOn('u1', { id: 'm-u1', name: 'm', meshIp: '100.64.0.9' }, 'luno', 'install-again')).toMatchObject({ ok: true });
    expect((await db.instances.getInstances('u1'))[0]!.groups).toEqual([{ projectId: 'p1', name: 'acme' }]);
  });
});

describe('a trial instance on Koala\'s servers', () => {
  let started: Array<{ instanceId: string; ownerId: string }>;
  let changed: string[];
  let removed: string[];
  const pooled = (pool: { slots: number; trialDays: number } | { off: string } = { slots: 2, trialDays: 14 }) => {
    started = [];
    changed = [];
    removed = [];
    return new InstanceService(db, { ...settings, pool }, mesh, () => now, () => {}, { start: async (instanceId, ownerId) => { started.push({ instanceId, ownerId }); }, trialChanged: async (instanceId) => { changed.push(instanceId); }, remove: async (instanceId) => { removed.push(instanceId); } });
  };

  it('is offered while the pool has room, with how long the trial lasts', async () => {
    expect(await pooled().poolOffer('u1')).toEqual({ available: true, trialDays: 14 });
    expect(await pooled({ off: 'this root has no pool (POOL_ADDRESS is not set)' }).poolOffer('u1')).toEqual({ available: false, reason: 'this root has no pool (POOL_ADDRESS is not set)' });
    expect(await service.poolOffer('u1')).toEqual({ available: false, reason: 'this root has no pool' });
  });

  it('is made under the name picked, with ports of its own and a trial that ends after the trial days, and its install started', async () => {
    const pool = pooled();
    const made = await pool.createPoolInstance('u1', 'alice');
    expect(made).toEqual({ ok: true, value: { id: instanceIdFor('u1'), name: 'alice', trialEndsAt: '2026-10-16T12:00:00.000Z' } });
    expect(started).toEqual([{ instanceId: instanceIdFor('u1'), ownerId: 'u1' }]);
    const record = (await db.instances.getInstances('u1'))[0]!;
    expect(record).toMatchObject({ status: 'installing', name: 'alice', pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: now.toISOString() } });
    expect(await pool.mine('u1')).toMatchObject({ status: 'installing', trialEndsAt: '2026-10-16T12:00:00.000Z' });

    expect(await pool.createPoolInstance('u2', 'bob')).toMatchObject({ ok: true });
    expect((await db.instances.getInstances('u2'))[0]!.pool!.ports.backend).toBe(35003);
  });

  it('says when the pool is full, and lets nobody past it, though someone already in it is still offered theirs', async () => {
    const pool = pooled({ slots: 1, trialDays: 14 });
    await pool.createPoolInstance('u1', 'alice');
    expect(await pool.poolOffer('u2')).toMatchObject({ available: false, reason: containing('full') });
    expect(await pool.createPoolInstance('u2', 'bob')).toMatchObject({ ok: false, status: 503 });
    expect(await pool.poolOffer('u1')).toMatchObject({ available: true });
  });

  it('refuses someone who already has Koala on their own machine, a name that is taken, and a second one', async () => {
    const pool = pooled();
    await placedFor('u1', 'luno');
    expect(await pool.createPoolInstance('u1', 'luno')).toEqual({ ok: false, status: 400, error: 'you already have Koala on your own machine' });
    expect(await pool.createPoolInstance('u2', 'luno')).toMatchObject({ ok: false, status: 400, error: '"luno" is taken' });
    await pool.createPoolInstance('u3', 'carol');
    expect(await pool.createPoolInstance('u3', 'carol')).toMatchObject({ ok: false, error: 'your instance on Koala\'s servers is already there' });
  });

  it('can be tried again after its install failed, keeping its ports and freeing its slot meanwhile', async () => {
    const pool = pooled({ slots: 1, trialDays: 14 });
    await pool.createPoolInstance('u1', 'alice');
    const record = (await db.instances.getInstances('u1'))[0]!;
    await db.instances.saveInstance({ ...record, status: 'failed', detail: 'no gVisor' });
    expect(await pool.poolOffer('u2')).toMatchObject({ available: true });
    expect(await pool.createPoolInstance('u1', 'alice')).toMatchObject({ ok: true });
    expect((await db.instances.getInstances('u1'))[0]!.pool!.ports).toEqual(record.pool!.ports);
    expect(started).toHaveLength(2);
  });

  it('is never replaced by a join command for a machine, which would lose it', async () => {
    const pool = pooled();
    await pool.createPoolInstance('u1', 'alice');
    expect(await pool.createJoinToken('u1', 'alice')).toMatchObject({ ok: false, status: 400, error: containing('moving it to your own machine keeps your work') });
    expect((await db.instances.getInstances('u1'))[0]!.pool).toBeDefined();
  });

  it('says so when its install cannot start, and leaves it failed rather than installing forever', async () => {
    const broken = new InstanceService(db, { ...settings, pool: { slots: 1, trialDays: 14 } }, mesh, () => now, () => {}, { start: async () => { throw new Error('Temporal is not reachable'); }, trialChanged: async () => {}, remove: async () => {} });
    expect(await broken.createPoolInstance('u1', 'alice')).toEqual({ ok: false, status: 503, error: 'setting up your instance could not start: Temporal is not reachable' });
    expect(await broken.mine('u1')).toMatchObject({ status: 'failed', detail: 'Setting it up could not start: Temporal is not reachable' });
    expect(await broken.poolOffer('u2')).toMatchObject({ available: true });
  });

  it('lets an admin set how long new trials last, which every new trial then gets', async () => {
    const pool = pooled();
    expect(await pool.setTrialDays('admin', 0)).toMatchObject({ ok: false, status: 400 });
    expect(await pool.setTrialDays('admin', 7.5)).toMatchObject({ ok: false, status: 400 });
    expect(await pool.setTrialDays('admin', 21)).toEqual({ ok: true, value: { trialDays: 21, updatedAt: now.toISOString(), updatedBy: 'admin' } });
    expect(await pool.poolOffer('u1')).toEqual({ available: true, trialDays: 21 });
    expect(await pool.createPoolInstance('u1', 'alice')).toMatchObject({ ok: true, value: { trialEndsAt: '2026-10-23T12:00:00.000Z' } });
    expect(await pool.poolAdmin()).toMatchObject({ ok: true, value: { slots: 2, trialDays: 21, defaultTrialDays: 14, instances: [{ name: 'alice', status: 'installing' }] } });
  });

  it('lets an admin move one person\'s trial end, warning again before the new end and waking their trial', async () => {
    const pool = pooled();
    const { value } = await pool.createPoolInstance('u1', 'alice') as { value: { id: string } };
    const record = (await db.instances.getInstances('u1'))[0]!;
    await db.instances.saveInstance({ ...record, pool: { ...record.pool!, told: ['warn-3d'] } });
    expect(await pool.setTrialEnd(value.id, '2026-09-01T00:00:00Z')).toMatchObject({ ok: false, status: 400, error: 'the new end of the trial has to be in the future' });
    expect(await pool.setTrialEnd(value.id, 'soon')).toMatchObject({ ok: false, status: 400 });
    expect(await pool.setTrialEnd('nobody', '2026-12-01T00:00:00Z')).toMatchObject({ ok: false, status: 404 });
    expect(await pool.setTrialEnd(value.id, '2026-12-01T00:00:00Z')).toMatchObject({ ok: true, value: { name: 'alice', trialEndsAt: '2026-12-01T00:00:00.000Z' } });
    expect((await db.instances.getInstances('u1'))[0]!.pool).toMatchObject({ trialEndsAt: '2026-12-01T00:00:00.000Z', told: [] });
    expect(changed).toEqual([value.id]);
  });

  it('lets an admin delete one, once they type its name, and starts its removal', async () => {
    const pool = pooled();
    const { value } = await pool.createPoolInstance('u1', 'alice') as { value: { id: string } };
    expect(await pool.removePoolInstance(value.id, 'alise')).toMatchObject({ ok: false, status: 400, error: containing('"alice"') });
    expect(removed).toEqual([]);
    expect(await pool.removePoolInstance(value.id, 'alice')).toEqual({ ok: true, value: { removing: 'alice' } });
    expect(removed).toEqual([value.id]);
    expect(await pool.mine('u1')).toMatchObject({ status: 'paused', detail: 'Being deleted' });
  });

  it('tells an instance, by its credential, when its trial ends, and an instance not on the pool that it has none', async () => {
    const pool = pooled();
    await pool.createPoolInstance('u1', 'alice');
    const id = instanceIdFor('u1');
    const record = (await db.instances.getInstances('u1'))[0]!;
    await db.instances.saveInstance({ ...record, credentialHash: hashCredential('secret') });
    expect(await pool.trialOf(id, 'secret')).toEqual({ ok: true, value: { trialEndsAt: '2026-10-16T12:00:00.000Z' } });
    expect(await pool.trialOf(id, 'wrong')).toMatchObject({ ok: false, status: 401 });
  });
});

describe('moving a trial instance to the person\'s own machine', () => {
  const calls: string[] = [];
  const workflows = {
    start: async () => {}, trialChanged: async () => {}, remove: async () => {},
    move: async (id: string) => { calls.push(`move ${id}`); },
    moveFinished: async (id: string) => { calls.push(`finished ${id}`); },
    moveStopped: async (id: string, reason: string) => { calls.push(`stopped ${id}: ${reason}`); },
  };
  const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: '2026-10-01T00:00:00.000Z', trialEndsAt: '2026-10-15T00:00:00.000Z' };
  const desk = { id: 'desk', name: 'bo-desktop', meshIp: '100.64.0.20' };
  const moves = {
    joinCode: async (ownerId: string, koalaName: string) => {
      calls.push(`code ${ownerId} ${koalaName}`);
      return { code: 'c0de', command: 'curl -fsSL https://app.example.com/machine.sh | sh -s -- c0de', expiresAt: '2026-10-02T13:00:00.000Z' };
    },
    poolClusterId: (name: string) => `pool-${name}`,
  };
  const installs = {
    setupHeard: async (installId: string, report: unknown) => { calls.push(`setup ${installId} ${JSON.stringify(report)}`); return { ok: true as const, value: { recorded: true as const } }; },
    progressHeard: async (installId: string, progress: unknown) => { calls.push(`progress ${installId} ${JSON.stringify(progress)}`); return { ok: true as const, value: { recorded: true as const } }; },
  };
  const record = async () => (await db.instances.getInstances()).find((entry) => entry.id === 'inst-bo')!;
  const placedOnDesk = async () => {
    const placing = await service.placeOn('bo', desk, undefined, 'install-1');
    if (!placing.ok) throw new Error(placing.error);
    const placed = await service.placedKoala('install-1', desk);
    if (!placed.ok) throw new Error(placed.error);
    return placed.value;
  };

  beforeEach(async () => {
    calls.length = 0;
    service = new InstanceService(db, { ...settings, pool: { slots: 2, trialDays: 14 }, moves, installs }, mesh, () => now, () => { routeChanges += 1; }, workflows);
    await db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', name: 'bo', url: 'https://bo.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('pool-secret'), meshIp: '100.64.0.9', pool });
  });

  it('gives the person the command that adds a machine, marked to bring this Koala over, and wakes the move', async () => {
    expect(await service.startMove('bo')).toEqual({ ok: true, value: { command: 'curl -fsSL https://app.example.com/machine.sh | sh -s -- c0de', expiresAt: '2026-10-02T13:00:00.000Z' } });
    expect(calls).toEqual(['code bo bo', 'move inst-bo']);
    expect(await service.moveOf('bo')).toMatchObject({ state: 'waiting' });
    expect((await service.startMove('bo')).ok).toBe(true);
    expect(calls).toEqual(['code bo bo', 'move inst-bo', 'code bo bo']);
  });

  it('says so when it cannot make the command, and when this root cannot move instances', async () => {
    service = new InstanceService(db, { ...settings, pool: { slots: 2, trialDays: 14 }, moves: { ...moves, joinCode: async () => { throw Object.assign(new Error('Koala\'s root runs no private network'), { status: 409 }); } } }, mesh, () => now, () => undefined, workflows);
    expect(await service.startMove('bo')).toEqual({ ok: false, status: 409, error: 'Koala\'s root runs no private network' });
    expect(calls).toEqual([]);
    service = new InstanceService(db, { ...settings, pool: { slots: 2, trialDays: 14 } }, mesh, () => now, () => undefined, workflows);
    expect(await service.startMove('bo')).toMatchObject({ ok: false, status: 503 });
    expect(await service.placeOn('bo', desk, undefined, 'install-1')).toMatchObject({ ok: false, status: 503 });
  });

  it('puts Koala on a machine of a person whose Koala is on Koala\'s servers as a move, leaving the pool copy serving', async () => {
    expect(await service.placeOn('bo', desk, undefined, 'install-1')).toEqual({ ok: true, value: { instanceId: 'inst-bo' } });
    expect(calls).toEqual(['move inst-bo']);
    expect(await record()).toMatchObject({
      status: 'ready', url: 'https://bo.koala.dev', meshIp: '100.64.0.9', credentialHash: hashCredential('pool-secret'),
      install: { id: 'install-1', machineId: 'desk', state: 'asked', move: true },
      move: { state: 'joined', detail: 'Asking bo-desktop to move Koala onto itself', target: { machine: 'bo-desktop', meshIp: '100.64.0.20' } },
    });
    expect((await record()).machineId).toBeUndefined();
    expect(await service.mine('bo')).toMatchObject({ status: 'ready', move: { state: 'joined', machine: 'bo-desktop' }, install: { id: 'install-1', move: true } });
    expect(await service.placeOn('bo', desk, 'other', 'install-2')).toMatchObject({ ok: false, status: 400 });
    expect(await service.placeOn('bo', desk, undefined, 'install-2')).toEqual({ ok: true, value: { instanceId: 'inst-bo', replaces: 'install-1' } });
    expect(calls).toEqual(['move inst-bo']);
  });

  it('hands the machine the move\'s own credential and where the move comes from, keeping the pool copy\'s credential until the switch', async () => {
    const placed = await placedOnDesk();
    expect(placed).toMatchObject({ installId: 'install-1', instanceId: 'inst-bo', machineId: 'desk', meshAddress: '100.64.0.20', name: 'bo', move: { fromClusterId: 'pool-bo' } });
    expect(await record()).toMatchObject({ credentialHash: hashCredential('pool-secret'), move: { credentialHash: hashCredential(placed.credential) }, install: { imageTag: 'abc123' } });
    expect((await service.ownerOf('inst-bo', 'pool-secret')).ok).toBe(true);
    expect((await service.ownerOf('inst-bo', placed.credential)).ok).toBe(false);
    expect(await service.moveSource('inst-bo', placed.credential)).toEqual({ ok: true, value: { name: 'bo', instanceId: 'inst-bo' } });
    expect((await service.moveSource('inst-bo', 'pool-secret')).ok).toBe(false);
    expect(await service.installedUrl((await service.installOf('install-1'))!, 'http://100.64.0.20:30320')).toEqual({ ok: true, value: 'http://100.64.0.20:30320' });
    expect((await service.installedUrl((await service.installOf('install-1'))!, 'http://100.64.0.9:30320')).ok).toBe(false);
  });

  it('hands what the Koala it moves to says to its install: its setup, its lines, and its failure with why', async () => {
    const { credential } = await placedOnDesk();
    await db.instances.updateInstall('inst-bo', 'install-1', { 'install.state': 'installing', 'install.stage': 'koala', 'install.title': 'Bringing Koala over' });
    const line = { revision: 1, progress: { stage: 'gitea', title: 'Gitea, your repositories and images', state: 'started' } };
    expect(await service.report('inst-bo', credential, { provision: line })).toMatchObject({ ok: true });
    expect(await service.report('inst-bo', credential, { status: 'installing', detail: 'Copying its secrets' })).toMatchObject({ ok: true });
    expect(await service.report('inst-bo', credential, { status: 'failed', detail: 'the pool copy did not answer' })).toMatchObject({ ok: true });
    expect(calls.slice(1)).toEqual([
      `setup install-1 ${JSON.stringify(line)}`,
      `progress install-1 ${JSON.stringify({ stage: 'koala', title: 'Bringing Koala over', state: 'started', line: 'Copying its secrets' })}`,
      `progress install-1 ${JSON.stringify({ stage: 'koala', title: 'Bringing Koala over', state: 'failed', why: 'the pool copy did not answer' })}`,
    ]);
    expect(await record()).toMatchObject({ status: 'ready', url: 'https://bo.koala.dev', move: { state: 'joined' } });
    expect((await service.report('inst-bo', credential, { status: 'ready', moved: true, url: 'http://100.64.0.20:30320' })).ok).toBe(true);
    expect(calls.filter((call) => call.startsWith('finished'))).toEqual([]);
  });

  it('hears nothing from a move whose install has ended or never was', async () => {
    await db.instances.saveInstance({ ...(await record()), move: { state: 'copying', startedAt: 'now', credentialHash: hashCredential('move-secret') } });
    expect(await service.report('inst-bo', 'move-secret', { status: 'installing', detail: 'Copying' })).toMatchObject({ ok: false, status: 409 });
    expect(await service.report('inst-bo', 'move-secret', { provision: { revision: 1, progress: { stage: 'gitea', title: 'Gitea', state: 'started' } } })).toMatchObject({ ok: false, status: 409 });
  });

  it('tries again on the same machine once a move stopped, as a new move', async () => {
    await placedOnDesk();
    await db.instances.saveInstance({ ...(await record()), move: { ...(await record()).move!, state: 'failed', detail: 'Moving Koala to bo-desktop stopped at Bringing Koala over: no room' }, install: { ...(await record()).install!, state: 'failed' } });
    expect(await service.placeOn('bo', desk, undefined, 'install-2')).toEqual({ ok: true, value: { instanceId: 'inst-bo' } });
    expect(calls).toEqual(['move inst-bo', 'move inst-bo']);
    expect((await record()).move).toMatchObject({ state: 'joined' });
    expect((await record()).move!.credentialHash).toBeUndefined();
  });

  it('refuses a move code once the Koala it was for is no longer on Koala\'s servers, and a move of a Koala still being set up', async () => {
    await db.instances.saveInstance({ ...(await record()), status: 'installing' });
    expect(await service.placeOn('bo', desk, undefined, 'install-1')).toMatchObject({ ok: false, status: 409, error: 'the instance is still being set up; move it once it runs' });
    expect(await service.placeOn('cy', desk, 'cy', 'install-2', true)).toMatchObject({ ok: false, status: 409, error: 'your Koala is not on Koala\'s servers, so there is nothing of it to move' });
  });

  it('keeps root\'s word on a pool instance\'s state: its own check-in neither makes it ready early nor changes it while it moves', async () => {
    const record = (await db.instances.getInstances()).find((entry) => entry.id === 'inst-bo')!;
    await db.instances.saveInstance({ ...record, status: 'installing', url: '' });
    await service.report('inst-bo', 'pool-secret', { status: 'ready', detail: 'Running dev' });
    expect(await service.mine('bo')).toMatchObject({ status: 'installing', url: '' });
    await db.instances.saveInstance({ ...record, status: 'ready', move: { state: 'copying', startedAt: 'now' } });
    await service.report('inst-bo', 'pool-secret', { status: 'installing', detail: 'Upgrading' });
    expect(await service.mine('bo')).toMatchObject({ status: 'ready' });
    await db.instances.saveInstance({ ...record, status: 'ready' });
    await service.report('inst-bo', 'pool-secret', { status: 'installing', detail: 'Upgrading from a to b' });
    expect(await service.mine('bo')).toMatchObject({ status: 'installing', detail: 'Upgrading from a to b' });
  });

  it('never lets a normal install command take over an instance on Koala\'s servers', async () => {
    await db.instances.saveJoinToken({ hash: hashCredential('plain'), ownerId: 'bo', instanceId: 'inst-bo', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(await service.join('plain', 'desk')).toMatchObject({ ok: false, status: 409 });
    expect((await service.ownerOf('inst-bo', 'pool-secret')).ok).toBe(true);
  });

  it('says a stopped instance is started again for the move before it waits for the machine', async () => {
    await db.instances.saveInstance({ ...(await db.instances.getInstances()).find((entry) => entry.id === 'inst-bo')!, status: 'paused' });
    expect((await service.startMove('bo')).ok).toBe(true);
    expect(await service.moveOf('bo')).toMatchObject({ state: 'waiting', detail: 'Starting your stopped instance so it can move' });
    expect((await db.instances.getInstances()).find((entry) => entry.id === 'inst-bo')?.move?.wasPaused).toBe(true);
  });

  it('starts from the instance itself with its credential, and refuses what cannot move', async () => {
    expect((await service.startMoveAs('inst-bo', 'pool-secret')).ok).toBe(true);
    expect((await service.startMoveAs('inst-bo', 'wrong')).ok).toBe(false);
    await db.instances.saveInstance({ id: instanceIdFor('cy'), ownerId: 'cy', name: 'cy', url: 'https://cy.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then' });
    expect(await service.startMove('cy')).toMatchObject({ ok: false, status: 409 });
    expect(await service.startMove('nobody')).toMatchObject({ ok: false, status: 404 });
    expect(await service.stopMove('bo')).toEqual({ ok: true, value: { stopping: true } });
    expect(calls.at(-1)).toBe('stopped inst-bo: you stopped the move');
  });
});

describe('which release an instance runs', () => {
  const catalogue = (charts: string[]) => ({
    releases: async () => [
      { imageTag: 'old111', version: 'v2026.10.24', servedAt: '2026-10-24T00:00:00.000Z' },
      { imageTag: 'mid222', version: 'v2026.10.25', servedAt: '2026-10-25T00:00:00.000Z', hotfix: true },
      { imageTag: 'abc123', version: 'v2026.10.26', servedAt: '2026-10-26T00:00:00.000Z', digest: `sha256:${'d'.repeat(64)}`, chartSha256: 'c'.repeat(64) },
    ],
    hasChart: (imageTag: string) => charts.includes(imageTag),
  });

  const joined = async () => {
    service = new InstanceService(db, { ...settings, releases: catalogue(['old111', 'mid222', 'abc123']) }, mesh, () => now);
    const made = await placedFor('u1');
    return { id: made.instanceId, credential: made.credential };
  };

  it('follows root on auto, from the release it reports running, with that release\'s own chart', async () => {
    const { id, credential } = await joined();
    expect(await service.report(id, credential, { status: 'ready', imageTag: 'old111' })).toMatchObject({ ok: true, value: { running: 'old111' } });
    expect(await service.release(id, credential)).toEqual({ ok: true, value: { imageTag: 'abc123', chartUrl: 'https://app.example.com/api/instances/chart.tgz', digest: `sha256:${'d'.repeat(64)}`, chartSha256: 'c'.repeat(64) } });
    expect(await service.report(id, credential, { status: 'ready', imageTag: 'abc123' })).toMatchObject({ ok: true, value: { running: 'abc123', previous: 'old111' } });
  });

  it('installs a new instance from the image and chart root released, by digest and checksum, and an older release without them as before', async () => {
    service = new InstanceService(db, { ...settings, releases: catalogue(['old111', 'mid222', 'abc123']) }, mesh, () => now);
    const machine = { id: 'm-u1', name: 'm', meshIp: '100.64.0.9' };
    await service.placeOn('u1', machine, 'luno', 'install-first');
    expect(await service.placedKoala('install-first', machine)).toMatchObject({ ok: true, value: { imageTag: 'abc123', imageDigest: `sha256:${'d'.repeat(64)}`, chartSha256: 'c'.repeat(64) } });
    const { id, credential } = await joined();
    await service.report(id, credential, { status: 'ready', imageTag: 'old111' });
    await service.setUpdates(id, credential, { version: 'v2026.10.24' });
    const older = await service.release(id, credential);
    expect(older).toEqual({ ok: true, value: { imageTag: 'old111', chartUrl: 'https://app.example.com/api/instances/chart/old111.tgz' } });
  });

  it('stays where it is once automatic updates are off, and moves to the release picked', async () => {
    const { id, credential } = await joined();
    await service.report(id, credential, { status: 'ready', imageTag: 'old111' });
    expect(await service.setUpdates(id, credential, { auto: false })).toMatchObject({ ok: true, value: { auto: false, picked: 'old111', target: 'old111' } });
    expect(await service.release(id, credential)).toMatchObject({ ok: true, value: { imageTag: 'old111' } });
    expect(await service.setUpdates(id, credential, { version: 'v2026.10.25' })).toMatchObject({ ok: true, value: { auto: false, picked: 'mid222', target: 'mid222' } });
    expect(await service.release(id, credential)).toEqual({ ok: true, value: { imageTag: 'mid222', chartUrl: 'https://app.example.com/api/instances/chart/mid222.tgz' } });
    expect(await service.setUpdates(id, credential, { auto: true })).toMatchObject({ ok: true, value: { auto: true, target: 'abc123' } });
  });

  it('lets it go back only to the release it ran just before', async () => {
    const { id, credential } = await joined();
    await service.report(id, credential, { status: 'ready', imageTag: 'mid222' });
    await service.report(id, credential, { status: 'ready', imageTag: 'abc123' });
    expect(await service.setUpdates(id, credential, { version: 'v2026.10.24' })).toMatchObject({ ok: false, status: 409, error: containing('back to v2026.10.25, the one it ran before') });
    expect(await service.setUpdates(id, credential, { version: 'v2026.10.25' })).toMatchObject({ ok: true, value: { target: 'mid222' } });
  });

  it('does not count an upgrade that failed and rolled back as running, and refuses what it cannot read', async () => {
    const { id, credential } = await joined();
    await service.report(id, credential, { status: 'ready', imageTag: 'old111' });
    expect(await service.report(id, credential, { status: 'failed', imageTag: 'abc123', detail: 'rolled back' })).toMatchObject({ ok: true, value: { running: 'old111' } });
    expect(await service.report(id, credential, { status: 'ready', imageTag: 'a b' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.setUpdates(id, credential, { auto: true, version: 'v2026.10.25' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.setUpdates(id, credential, { version: 'v2027.01.01' })).toMatchObject({ ok: false, status: 409, error: 'there is no release v2027.01.01' });
    expect(await service.updates(id, 'guess')).toMatchObject({ ok: false, status: 401 });
  });
});

describe('whether root tells an owner their instance cannot be reached', () => {
  it('is on by default for an own machine, switched by the instance with its credential or by the owner on root', async () => {
    const { instanceId, credential } = await placedFor('u1');
    expect(await service.watchAs(instanceId, credential)).toEqual({ ok: true, value: { notifyWhenUnreachable: true, alwaysTold: false } });
    expect(await service.watchAs(instanceId, 'wrong')).toMatchObject({ ok: false, status: 401 });
    expect(await service.setWatchAs(instanceId, credential, 'no')).toMatchObject({ ok: false, status: 400 });
    expect(await service.setWatchAs(instanceId, credential, false)).toEqual({ ok: true, value: { notifyWhenUnreachable: false, alwaysTold: false } });
    expect((await service.mine('u1'))?.watch).toEqual({ notifyWhenUnreachable: false, alwaysTold: false });
    expect(await service.setWatchOf('u1', true)).toMatchObject({ ok: true, value: { notifyWhenUnreachable: true } });
    expect(await service.setWatchOf('nobody', true)).toMatchObject({ ok: false, status: 404 });
    await db.instances.saveReach({ id: instanceId, ownerId: 'u1' }, { reachable: false, unreachableSince: now.toISOString(), toldDown: true });
    expect((await service.mine('u1'))?.watch.reach).toEqual({ reachable: false, unreachableSince: now.toISOString(), toldDown: true });
    await db.instances.deleteInstance(instanceId);
    expect(await db.instances.getWatch(instanceId)).toBeUndefined();
  });

  it('always tells about a trial on Koala\'s servers, and refuses switching it off', async () => {
    const pool = new InstanceService(db, { ...settings, pool: { slots: 2, trialDays: 14 } }, mesh, () => now, () => {}, { start: async () => undefined, trialChanged: async () => undefined, remove: async () => undefined });
    expect(await pool.createPoolInstance('u2', 'trial')).toMatchObject({ ok: true });
    expect((await pool.mine('u2'))?.watch).toEqual({ notifyWhenUnreachable: true, alwaysTold: true });
    expect(await pool.setWatchOf('u2', false)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('an instance asking root about itself', () => {
  const pooled = { id: 'inst-p', ownerId: 'p1', name: 'alice', status: 'ready', url: '', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('secret'), running: 'abc123', pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 'then', trialEndsAt: '2026-11-03T00:00:00.000Z' } } as const;

  it('says which release it runs, to its own credential only', async () => {
    await db.instances.saveInstance({ ...pooled });
    expect(await service.runningOf('inst-p', 'secret')).toEqual({ ok: true, value: { running: 'abc123' } });
    expect(await service.runningOf('inst-p', 'wrong')).toEqual({ ok: false, status: 401, error: 'unknown instance or credential' });
  });

  it('names its place on Koala\'s servers, to its own credential only', async () => {
    await db.instances.saveInstance({ ...pooled });
    expect(await service.poolPlaceOf('inst-p', 'secret')).toEqual({ ok: true, value: { name: 'alice', hostNamespace: 'pool-alice' } });
    expect(await service.poolPlaceOf('inst-p', 'wrong')).toMatchObject({ ok: false, status: 401 });
  });

  it('has no place there when it runs on its owner\'s machine, or is stopped', async () => {
    await db.instances.saveInstance({ ...pooled, id: 'inst-own', ownerId: 'o1', name: 'own', pool: undefined });
    expect(await service.poolPlaceOf('inst-own', 'secret')).toEqual({ ok: false, status: 404, error: 'this instance does not run on Koala\'s servers' });
    await db.instances.saveInstance({ ...pooled, status: 'paused' });
    expect(await service.poolPlaceOf('inst-p', 'secret')).toEqual({ ok: false, status: 409, error: 'this instance is stopped' });
  });
});

describe('putting a person\'s Koala on one of their machines', () => {
  const desk = { id: 'desk', name: 'desk', meshIp: '100.64.0.7' };

  it('makes their instance on the machine with an install asked of it, and hands the machine everything to install it, a credential only it holds', async () => {
    expect(await service.placeOn('u1', desk, 'luno', 'install-1')).toEqual({ ok: true, value: { instanceId: instanceIdFor('u1') } });
    expect((await db.instances.getInstances('u1'))[0]).toMatchObject({ status: 'joined', machine: 'desk', machineId: 'desk', meshIp: '100.64.0.7', name: 'luno', install: { id: 'install-1', machineId: 'desk', state: 'asked' } });
    const placed = await service.placedKoala('install-1', desk);
    expect(placed).toMatchObject({ ok: true, value: {
      installId: 'install-1', instanceId: instanceIdFor('u1'), ownerId: 'u1', machineId: 'desk', rootUrl: 'https://app.example.com', rootPublicKeys: 'PEM-1',
      meshLoginServer: 'https://mesh.example.com', meshAddress: '100.64.0.7', image: '100.64.0.1:5001/nowrinkles/app', imageTag: 'abc123',
      chartUrl: 'https://app.example.com/api/instances/chart.tgz', name: 'luno', domain: 'koala.dev',
    } });
    if (!placed.ok) throw new Error(placed.error);
    expect((await db.instances.getInstances('u1'))[0]).toMatchObject({ credentialHash: hashCredential(placed.value.credential), install: { imageTag: 'abc123' } });
    const again = await service.placedKoala('install-1', desk);
    if (!again.ok) throw new Error(again.error);
    expect(again.value.credential).not.toBe(placed.value.credential);
  });

  it('puts it again on the same machine, naming the install it replaces, and refuses another machine while one holds it, and one off the mesh', async () => {
    await service.placeOn('u1', desk, 'luno', 'install-1');
    expect(await service.placeOn('u1', desk, undefined, 'install-2')).toEqual({ ok: true, value: { instanceId: instanceIdFor('u1'), replaces: 'install-1' } });
    expect(await service.placedKoala('install-1', desk)).toMatchObject({ ok: false, status: 404 });
    expect(await service.placedKoala('install-2', { id: 'laptop', name: 'laptop', meshIp: '100.64.0.8' })).toMatchObject({ ok: false, status: 404 });
    expect(await service.placeOn('u1', { id: 'laptop', name: 'laptop', meshIp: '100.64.0.8' }, undefined, 'install-3')).toMatchObject({ ok: false, status: 409, error: 'your Koala is on desk; moving it is a step of its own' });
    expect(await service.placeOn('u2', { id: 'nas', name: 'nas' }, 'nasbox', 'install-4')).toMatchObject({ ok: false, status: 409, error: 'nas is not on your private network yet; Koala is put on it once it is' });
  });

  it('finds an instance by its install, and takes where Koala answers on the machine only at the instance\'s own mesh address', async () => {
    await service.placeOn('u1', desk, 'luno', 'install-1');
    const instance = await service.installOf('install-1');
    expect(instance).toMatchObject({ id: instanceIdFor('u1'), install: { id: 'install-1' } });
    expect(await service.installOf('install-0')).toBeUndefined();
    expect(await service.installedUrl(instance!, 'http://100.64.0.7:30320/')).toEqual({ ok: true, value: 'http://100.64.0.7:30320' });
    expect(await service.installedUrl(instance!, 'http://100.64.0.8:30320')).toMatchObject({ ok: false, status: 400, error: matching(/^root does not call http:\/\/100\.64\.0\.8:30320/) });
    expect(await service.installedUrl(instance!, 'javascript:alert(1)')).toMatchObject({ ok: false, status: 400 });
  });

  it('ends an install it could not start as failed, saying why, and shows the person its stage', async () => {
    await service.placeOn('u1', desk, 'luno', 'install-1');
    await service.installNotStarted(instanceIdFor('u1'), 'install-1', 'root could not start putting Koala on desk: Temporal is down');
    expect(await service.placedKoala('install-1', desk)).toMatchObject({ ok: false, status: 404 });
    expect(await service.mine('u1')).toMatchObject({ status: 'failed', detail: 'root could not start putting Koala on desk: Temporal is down', install: { id: 'install-1', machineId: 'desk', state: 'failed', why: 'root could not start putting Koala on desk: Temporal is down' } });
    expect((await service.installsOn('desk')).map((instance) => instance.id)).toEqual([instanceIdFor('u1')]);
  });
});

describe('an instance telling root how its setup after the chart goes', () => {
  const gitea = (state: 'started' | 'done' | 'failed', more: Record<string, string> = {}) => ({ stage: 'gitea', title: 'Gitea, your repositories and images', state, ...more });
  const setUp = { stage: 'set-up', title: 'Koala is set up', state: 'done' };

  const joinedOn = () => koalaPlacedAndUp(service, db, 'u1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' }, 'luno');

  it('shows each piece as it comes, fails at the piece that stopped, and is ready only once the setup says so', async () => {
    const { instanceId, credential } = await joinedOn();
    expect(await service.report(instanceId, credential, { provision: { revision: 1, progress: gitea('started', { line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' }) } }))
      .toMatchObject({ ok: true, value: { status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready', setup: { revision: 1, state: 'running', stage: 'gitea' } } });
    expect(await service.report(instanceId, credential, { provision: { revision: 1, progress: gitea('failed', { why: 'pod gitea-0 is Init:Error' }) } }))
      .toMatchObject({ ok: true, value: { status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea, your repositories and images: pod gitea-0 is Init:Error' } });
    expect(await service.report(instanceId, credential, { provision: { revision: 1, progress: setUp } })).toMatchObject({ ok: true, value: { status: 'ready', detail: 'Ready', setup: { revision: 1, state: 'up' } } });
    expect(await service.report(instanceId, credential, { provision: { revision: 0, progress: setUp } })).toMatchObject({ ok: false, status: 400, error: containing('"revision"') });
    expect(await service.report(instanceId, credential, { provision: { revision: 1, progress: { stage: 'koala', title: 'Koala', state: 'done' } } })).toMatchObject({ ok: false, status: 400, error: containing('"stage" is one of') });
    expect(await service.report(instanceId, credential, { status: 'ready', provision: { revision: 1, progress: setUp } })).toEqual({ ok: false, status: 400, error: 'a report of Koala\'s setup sends only "provision"' });
  });

  it('refuses, saying why, a setup for a revision it has moved past, keeping the one it follows', async () => {
    const { instanceId, credential } = await joinedOn();
    await service.report(instanceId, credential, { provision: { revision: 2, progress: gitea('started') } });
    expect(await service.report(instanceId, credential, { provision: { revision: 1, progress: setUp } })).toEqual({ ok: false, status: 409, error: 'root follows the setup of revision 2, so revision 1\'s is no longer this Koala\'s' });
    expect((await db.instances.getInstances('u1'))[0]!.setup).toMatchObject({ revision: 2, state: 'running' });
  });

  it('holds a report naming the revision it runs to that revision\'s setup, never ready before it nor over a piece that failed, while the release it runs is kept', async () => {
    const { instanceId, credential } = await joinedOn();
    expect(await service.report(instanceId, credential, { status: 'installing', detail: 'Upgraded to v8', imageTag: 'v8', revision: 2 })).toMatchObject({ ok: true, value: { status: 'installing', detail: 'Upgraded to v8', running: 'v8' } });
    await service.report(instanceId, credential, { provision: { revision: 2, progress: gitea('failed', { why: 'pod gitea-0 is Init:Error' }) } });
    expect(await service.report(instanceId, credential, { status: 'installing', detail: 'Running v8', imageTag: 'v8', revision: 2 })).toMatchObject({ ok: true, value: { status: 'failed', detail: containing('stopped setting itself up at Gitea') } });
    await service.report(instanceId, credential, { provision: { revision: 2, progress: setUp } });
    expect(await service.report(instanceId, credential, { status: 'installing', detail: 'Running v8', imageTag: 'v8', revision: 2 })).toMatchObject({ ok: true, value: { status: 'ready', detail: 'Running v8' } });
    expect(await service.report(instanceId, credential, { status: 'ready', detail: 'Running v8', revision: 2 })).toMatchObject({ ok: false, status: 400, error: containing('ready comes from') });
    expect(await service.report(instanceId, credential, { status: 'installing', revision: 'two' })).toMatchObject({ ok: false, status: 400 });
  });

  it('hands the setup of a Koala still being put on its machine to that install, and writes nothing itself', async () => {
    const handed: unknown[] = [];
    let down = false;
    service = new InstanceService(db, { ...settings, installs: { setupHeard: async (installId, report) => {
      if (down) return { ok: false, status: 503, error: 'root could not hand this to the install it follows: Temporal is down' };
      handed.push([installId, report]);
      return { ok: true, value: { recorded: true } };
    }, progressHeard: async () => ({ ok: true, value: { recorded: true } }) } }, mesh, () => now);
    const placed = await service.placeOn('u1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' }, 'luno', 'install-1');
    if (!placed.ok) throw new Error(placed.error);
    const koala = await service.placedKoala('install-1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' });
    if (!koala.ok) throw new Error(koala.error);
    const line = { revision: 1, progress: gitea('started') };
    expect(await service.report(placed.value.instanceId, koala.value.credential, { provision: line })).toMatchObject({ ok: true, value: { status: 'joined' } });
    expect(handed).toEqual([['install-1', line]]);
    expect((await db.instances.getInstances('u1'))[0]!.setup).toBeUndefined();
    down = true;
    expect(await service.report(placed.value.instanceId, koala.value.credential, { provision: line })).toMatchObject({ ok: false, status: 503 });
  });

  it('forgets the setup of a Koala it puts on a machine afresh, since a fresh chart counts its revisions from 1 again', async () => {
    const { instanceId, credential } = await joinedOn();
    await service.report(instanceId, credential, { provision: { revision: 4, progress: setUp } });
    await service.placeOn('u1', { id: 'desk', name: 'desk', meshIp: '100.64.0.7' }, 'luno', 'install-2');
    expect((await db.instances.getInstances('u1'))[0]!.setup).toBeUndefined();
  });
});

describe('a pool instance setting itself up', () => {
  const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: '2026-10-01T00:00:00.000Z', trialEndsAt: '2026-10-15T00:00:00.000Z' };
  const line = { revision: 1, progress: { stage: 'searxng', title: 'SearXNG, web search', state: 'started' } };
  let handed: unknown[];

  beforeEach(async () => {
    handed = [];
    service = new InstanceService(db, { ...settings, pool: { slots: 2, trialDays: 14 } }, mesh, () => now, () => undefined, {
      start: async () => {}, trialChanged: async () => {}, remove: async () => {},
      setupHeard: async (instanceId, report) => { handed.push([instanceId, report]); },
    });
  });

  const saved = async (more: Partial<InstanceRecord>) => {
    await db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', name: 'bo', url: '', status: 'installing', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('pool-secret'), pool: { ...pool, settingUp: true }, ...more });
  };

  it('is made waiting for its setup, which its own workflow hears while it is being placed', async () => {
    expect(await service.createPoolInstance('u1', 'alice')).toMatchObject({ ok: true });
    expect((await db.instances.getInstances('u1'))[0]!.pool).toMatchObject({ settingUp: true });
    await saved({});
    expect(await service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'installing' } });
    expect(handed).toEqual([['inst-bo', line]]);
  });

  it('records the setup of a placement that failed without undoing why it failed, and records it as its status once the placement has ended', async () => {
    await saved({ status: 'failed', detail: 'no gVisor' });
    expect(await service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'failed', detail: 'no gVisor', setup: { revision: 1, stage: 'searxng', state: 'running' } } });
    await saved({ status: 'ready', url: 'https://bo.koala.dev', pool });
    expect(await service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'installing', detail: 'Koala is setting itself up: SearXNG, web search' } });
    expect(handed).toEqual([]);
  });

  it('records the pool copy\'s setup while it moves, leaving the instance serving where it is', async () => {
    await saved({ status: 'ready', pool, move: { state: 'copying', startedAt: 'now' } });
    expect(await service.report('inst-bo', 'pool-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'ready', setup: { revision: 1, stage: 'searxng', state: 'running' } } });
    expect(handed).toEqual([]);
  });

  it('hands the setup of the Koala it moves to to the move\'s install, leaving the instance serving where it is', async () => {
    const setups: unknown[] = [];
    service = new InstanceService(db, { ...settings, pool: { slots: 2, trialDays: 14 }, installs: {
      setupHeard: async (installId, report) => { setups.push([installId, report]); return { ok: true, value: { recorded: true } }; },
      progressHeard: async () => ({ ok: true, value: { recorded: true } }),
    } }, mesh, () => now, () => undefined, { start: async () => {}, trialChanged: async () => {}, remove: async () => {} });
    await saved({ status: 'ready', pool, move: { state: 'copying', startedAt: 'now', detail: 'Copying its data', credentialHash: hashCredential('move-secret'), target: { machine: 'bo-desktop' } }, install: { id: 'install-1', machineId: 'desk', state: 'installing', at: 'now', move: true } });
    expect(await service.report('inst-bo', 'move-secret', { provision: line })).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(setups).toEqual([['install-1', line]]);
    expect(await service.report('inst-bo', 'move-secret', { provision: { revision: 0, progress: line.progress } })).toMatchObject({ ok: false, status: 400 });
    expect(handed).toEqual([]);
  });
});
