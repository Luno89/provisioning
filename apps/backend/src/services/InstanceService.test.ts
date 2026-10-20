import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { InstanceService, JOIN_TOKEN_TTL_SECONDS, instanceIdFor } from './InstanceService.js';

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

let db: MemoryDB;
let now: Date;
let service: InstanceService;
let routeChanges: number;

const tokenFor = async (ownerId: string, name: string = 'luno') => {
  const made = await service.createJoinToken(ownerId, name);
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
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

    const stored = (await db.getInstances('u1'))[0]!;
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
    await db.saveUser({ id: 'u3', email: 'sam.rivera@example.com' } as never);
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

describe('a trial instance on Koala\'s servers', () => {
  let started: Array<{ instanceId: string; ownerId: string }>;
  const pooled = (pool: { slots: number; trialDays: number } | { off: string } = { slots: 2, trialDays: 14 }) => {
    started = [];
    return new InstanceService(db, { ...settings, pool }, mesh, () => now, () => {}, async (instanceId, ownerId) => { started.push({ instanceId, ownerId }); });
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
    const record = (await db.getInstances('u1'))[0]!;
    expect(record).toMatchObject({ status: 'installing', name: 'alice', pool: { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: now.toISOString() } });
    expect(await pool.mine('u1')).toMatchObject({ status: 'installing', trialEndsAt: '2026-10-16T12:00:00.000Z' });

    expect(await pool.createPoolInstance('u2', 'bob')).toMatchObject({ ok: true });
    expect((await db.getInstances('u2'))[0]!.pool!.ports.backend).toBe(35003);
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
    const record = (await db.getInstances('u1'))[0]!;
    await db.saveInstance({ ...record, status: 'failed', detail: 'no gVisor' });
    expect(await pool.poolOffer('u2')).toMatchObject({ available: true });
    expect(await pool.createPoolInstance('u1', 'alice')).toMatchObject({ ok: true });
    expect((await db.getInstances('u1'))[0]!.pool!.ports).toEqual(record.pool!.ports);
    expect(started).toHaveLength(2);
  });

  it('is never replaced by a join command for a machine, which would lose it', async () => {
    const pool = pooled();
    await pool.createPoolInstance('u1', 'alice');
    expect(await pool.createJoinToken('u1', 'alice')).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('moving it to your own machine keeps your work') });
    expect((await db.getInstances('u1'))[0]!.pool).toBeDefined();
  });
});
