import { describe, it, expect, beforeEach } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { InstanceService, JOIN_TOKEN_TTL_SECONDS, hashCredential, instanceIdFor } from './InstanceService.js';

const settings = {
  rootUrl: 'https://app.example.com',
  rootPublicKeys: () => ['PEM-1'],
  meshLoginServer: 'https://mesh.example.com',
  registry: '100.64.0.1:5001',
  imageTag: 'abc123',
  chartVersion: '0.1.0',
  domain: 'koala.dev',
  siteNames: ['app', 'mesh'],
};
const mesh = { createPreAuthKey: async (ownerId: string) => ({ key: `pre-${ownerId}` }) };

let db: MongoDB;
let now: Date;
let service: InstanceService;
let routeChanges: number;

const tokenFor = async (ownerId: string, name: string = 'luno') => {
  const made = await service.createJoinToken(ownerId, name);
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

beforeEach(async () => {
  db = await testDatabase();
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

  it('mints a mesh key for a machine of the instance\'s owner, only for that instance', async () => {
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    expect(await service.machineKey(joined.value.instanceId, joined.value.credential)).toEqual({ ok: true, value: { preAuthKey: 'pre-u1', meshLoginServer: 'https://mesh.example.com' } });
    expect(await service.machineKey(joined.value.instanceId, 'guess')).toMatchObject({ ok: false, status: 401 });
    expect(await new InstanceService(db, { ...settings, meshLoginServer: undefined }, mesh, () => now).machineKey(joined.value.instanceId, joined.value.credential)).toMatchObject({ ok: false, status: 503 });
  });

  it('records what the machine reports, and where the instance answers', async () => {
    const { token } = await tokenFor('u1');
    const joined = await service.join(token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;

    expect(await service.report(instanceId, credential, { status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320/' })).toMatchObject({ ok: true });
    expect(await service.mine('u1')).toEqual({ id: instanceId, status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320', name: 'luno' });
    expect(await service.report(instanceId, credential, { status: 'exploded' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.report(instanceId, credential, { status: 'ready', url: 'javascript:alert(1)' })).toMatchObject({ ok: false, status: 400 });
  });

  it('will not let a machine join a root with no mesh or no registry', async () => {
    const { token } = await tokenFor('u1');
    const noRegistry = new InstanceService(db, { ...settings, registry: '' }, mesh, () => now);
    expect(await noRegistry.join(token, 'm')).toMatchObject({ ok: false, status: 503 });
  });
});

describe('an instance\'s name and addresses', () => {
  it('takes the name with the join command, refusing a bad one, one taken, and a change', async () => {
    expect(await service.createJoinToken('u1', 'shop-x')).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/no dashes/) });
    expect(await service.createJoinToken('u1', 'mesh')).toMatchObject({ ok: false, error: expect.stringMatching(/kept for the platform/) });
    expect(await service.createJoinToken('u1')).toMatchObject({ ok: false, error: 'pick a name for your instance' });
    await tokenFor('u1', 'luno');
    expect(await service.createJoinToken('u2', 'luno')).toMatchObject({ ok: false, error: '"luno" is taken' });
    expect(await service.nameCheck('u2', 'luno')).toEqual({ ok: false, problem: '"luno" is taken' });
    expect(await service.createJoinToken('u1', 'other')).toMatchObject({ ok: false, error: expect.stringMatching(/already named "luno"/) });
    expect(await service.createJoinToken('u1')).toMatchObject({ ok: true, value: { name: 'luno' } });
  });

  it('suggests a name from the person\'s email', async () => {
    await db.accounts.saveUser({ id: 'u3', email: 'sam.rivera@example.com' } as never);
    expect(await service.nameCheck('u3', undefined)).toEqual({ ok: false, suggestion: 'samrivera' });
    expect(await service.nameCheck('u3', 'samrivera')).toEqual({ ok: true, address: 'https://samrivera.koala.dev' });
  });

  it('keeps the mesh address the machine reports, and says the routes changed', async () => {
    const joined = await service.join((await tokenFor('u1')).token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;
    expect(await service.report(instanceId, credential, { status: 'joined', meshIp: '100.64.0.9' })).toMatchObject({ ok: true, value: { meshIp: '100.64.0.9' } });
    expect(await service.report(instanceId, credential, { status: 'joined', meshIp: '100.64.0.9 { import x }' })).toMatchObject({ ok: false, status: 400 });
    const before = routeChanges;
    await service.report(instanceId, credential, { status: 'ready' });
    expect(routeChanges).toBe(before + 1);
  });

  it('turns nested addresses on as issuing, only for the instance itself', async () => {
    const joined = await service.join((await tokenFor('u1')).token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    const { instanceId, credential } = joined.value;
    expect(await service.addresses(instanceId, credential)).toEqual({ ok: true, value: { nested: false, name: 'luno', domain: 'koala.dev' } });
    expect(await service.setAddresses(instanceId, credential, true)).toEqual({ ok: true, value: { nested: true, state: 'issuing', name: 'luno', domain: 'koala.dev' } });
    expect(await service.setAddresses(instanceId, 'guess', false)).toMatchObject({ ok: false, status: 401 });
    expect(await service.setAddresses(instanceId, credential, 'yes')).toMatchObject({ ok: false, status: 400 });
    expect(await new InstanceService(db, { ...settings, domain: undefined }, mesh, () => now).addresses(instanceId, credential)).toMatchObject({ ok: false, status: 503 });
  });
});

describe('the groups a shared project\'s apps are addressed under', () => {
  const joinedAs = async (ownerId: string, name: string) => {
    const joined = await service.join((await tokenFor(ownerId, name)).token, 'm');
    if (!joined.ok) throw new Error(joined.error);
    return joined.value;
  };

  it('checks a name against the rules, every instance\'s name and every group anywhere on root', async () => {
    const luno = await joinedAs('u1', 'luno');
    await joinedAs('u2', 'sam');
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'acme')).toEqual({ ok: true, value: { ok: true } });
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'ac-me')).toMatchObject({ ok: true, value: { ok: false, problem: expect.stringMatching(/no dashes/) } });
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'mesh')).toMatchObject({ ok: true, value: { ok: false, problem: expect.stringMatching(/kept for the platform/) } });
    expect(await service.checkGroup(luno.instanceId, luno.credential, 'app')).toMatchObject({ ok: true, value: { ok: false, problem: expect.stringMatching(/kept for the platform/) } });
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
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p1', 'other')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/already addressed under "acme"/) });
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p3', 'sam')).toEqual({ ok: false, status: 409, error: '"sam" is taken' });
    expect(await service.claimGroup(luno.instanceId, luno.credential, 'p3', 'shop-x')).toMatchObject({ ok: false, status: 400 });
    expect(await service.claimGroup(luno.instanceId, luno.credential, '', 'shop')).toMatchObject({ ok: false, status: 400 });
    expect(await service.claimGroup(luno.instanceId, 'guess', 'p4', 'shop')).toMatchObject({ ok: false, status: 401 });
    expect(await service.createJoinToken('u3', 'acme')).toMatchObject({ ok: false, error: '"acme" is taken' });
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

  it('keeps an instance\'s groups when its install command is made again', async () => {
    const luno = await joinedAs('u1', 'luno');
    await service.claimGroup(luno.instanceId, luno.credential, 'p1', 'acme');
    await tokenFor('u1', 'luno');
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
    expect(await pool.poolOffer('u2')).toMatchObject({ available: false, reason: expect.stringContaining('full') });
    expect(await pool.createPoolInstance('u2', 'bob')).toMatchObject({ ok: false, status: 503 });
    expect(await pool.poolOffer('u1')).toMatchObject({ available: true });
  });

  it('refuses someone who already has Koala on their own machine, a name that is taken, and a second one', async () => {
    const pool = pooled();
    const { token } = await tokenFor('u1', 'luno');
    await service.join(token, 'desk');
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
    expect(await pool.createJoinToken('u1', 'alice')).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('moving it to your own machine keeps your work') });
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
    expect(await pool.removePoolInstance(value.id, 'alise')).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('"alice"') });
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

  beforeEach(async () => {
    calls.length = 0;
    service = new InstanceService(db, { ...settings, pool: { slots: 2, trialDays: 14 } }, mesh, () => now, () => { routeChanges += 1; }, workflows);
    await db.instances.saveInstance({ id: 'inst-bo', ownerId: 'bo', name: 'bo', url: 'https://bo.koala.dev', status: 'ready', createdAt: 'then', updatedAt: 'then', credentialHash: hashCredential('pool-secret'), meshIp: '100.64.0.9', pool });
  });

  it('gives the person a move command for the same instance, and keeps the pool copy working until the new machine has everything', async () => {
    const started = await service.startMove('bo');
    if (!started.ok) throw new Error(started.error);
    expect(started.value.command).toBe(`curl -fsSL https://app.example.com/install.sh | sudo sh -s -- ${started.value.token}`);
    expect(calls).toEqual(['move inst-bo']);
    expect(await service.moveOf('bo')).toMatchObject({ state: 'waiting' });

    const joined = await service.join(started.value.token, 'bo-desktop');
    if (!joined.ok) throw new Error(joined.error);
    expect(joined.value).toMatchObject({ instanceId: 'inst-bo', name: 'bo', move: true });
    expect((await service.ownerOf('inst-bo', 'pool-secret')).ok).toBe(true);
    expect((await service.ownerOf('inst-bo', joined.value.credential)).ok).toBe(false);
    expect(await service.moveSource('inst-bo', joined.value.credential)).toEqual({ ok: true, value: { name: 'bo', instanceId: 'inst-bo' } });
    expect((await service.moveSource('inst-bo', 'pool-secret')).ok).toBe(false);

    await service.report('inst-bo', joined.value.credential, { status: 'installing', detail: 'Copying its secrets', meshIp: '100.64.0.20' });
    expect(await service.mine('bo')).toMatchObject({ status: 'ready', move: { state: 'copying', detail: 'Copying its secrets', machine: 'bo-desktop' } });
    expect((await db.instances.getInstances()).find((entry) => entry.id === 'inst-bo')?.meshIp).toBe('100.64.0.9');
    expect((await service.report('inst-bo', joined.value.credential, { status: 'ready', moved: true })).ok).toBe(false);
    await service.report('inst-bo', joined.value.credential, { status: 'ready', moved: true, url: 'https://bo.koala.dev', meshIp: '100.64.0.20' });
    expect(calls).toEqual(['move inst-bo', 'finished inst-bo']);
    expect(await service.moveOf('bo')).toMatchObject({ state: 'switching' });
    expect((await service.stopMove('bo')).ok).toBe(false);
  });

  it('stops when the new machine says it failed, and can start again with a new command', async () => {
    const started = await service.startMove('bo');
    if (!started.ok) throw new Error(started.error);
    const joined = await service.join(started.value.token, 'bo-desktop');
    if (!joined.ok) throw new Error(joined.error);
    await service.report('inst-bo', joined.value.credential, { status: 'failed', detail: 'The move stopped: finish or stop what runs first' });
    expect(calls).toEqual(['move inst-bo', 'stopped inst-bo: The move stopped: finish or stop what runs first']);
    expect(await service.moveOf('bo')).toMatchObject({ state: 'failed' });
    expect((await service.moveSource('inst-bo', joined.value.credential)).ok).toBe(false);
    const again = await service.startMove('bo');
    expect(again.ok).toBe(true);
    expect(calls.at(-1)).toBe('move inst-bo');
    expect(await service.moveOf('bo')).toMatchObject({ state: 'waiting' });
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
