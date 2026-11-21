import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../platform/index.js';
import { InstanceService, hashCredential, instanceIdFor } from '../services/InstanceService.js';
import { InstanceReach } from '../services/InstanceReach.js';
import { koalaPlacedAndUp } from './placed-koala.js';

export const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
export const containing = (text: string): unknown => expect.stringContaining(text);

export const settings = {
  rootUrl: 'https://app.example.com',
  rootPublicKeys: () => ['PEM-1'],
  meshLoginServer: 'https://mesh.example.com',
  registry: '100.64.0.1:5001',
  imageTag: 'abc123',
  domain: 'koala.dev',
  siteNames: ['app', 'mesh'],
};
const removedNodes: { ownerId: string; meshIp: string }[] = [];
export const mesh = { createPreAuthKey: async (ownerId: string) => ({ key: `pre-${ownerId}` }), removeNode: async (ownerId: string, meshIp: string) => { removedNodes.push({ ownerId, meshIp }); } };

export interface InstanceServiceWorld {
  readonly db: Database;
  readonly now: Date;
  service: InstanceService;
  placedOn(ownerId: string, name?: string): Promise<{ instanceId: string; credential: string }>;
}

export function instanceServiceBehaviour(make: () => Promise<Database>, start: () => Date): InstanceServiceWorld {
  let db: Database;
  let now: Date;
  let service: InstanceService;
  let routeChanges: number;

  const placedFor = async (ownerId: string, name: string = 'luno', on: InstanceService = service) =>
    koalaPlacedAndUp(on, db, ownerId, { id: `m-${ownerId}`, name: 'm', meshIp: '100.64.0.9' }, name);

  const placedOn = async (ownerId: string, name: string = 'luno') => {
    const machine = { id: `m-${ownerId}`, name: 'm', meshIp: '100.64.0.7' };
    const placing = await service.placeOn(ownerId, machine, name, `install-${ownerId}`);
    if (!placing.ok) throw new Error(placing.error);
    const placed = await service.placedKoala(`install-${ownerId}`, machine);
    if (!placed.ok) throw new Error(placed.error);
    return placed.value;
  };

  beforeEach(async () => {
    db = await make();
    now = start();
    routeChanges = 0;
    service = new InstanceService(db, settings, mesh, () => now, () => { routeChanges += 1; });
  });

  describe('bringing a user\'s own machine in as their instance', () => {
    it('names a person\'s Koala to their machines only once it is in service', async () => {
      expect(await service.koalaOf('u1')).toBeUndefined();
      const placed = await placedOn('u1');
      expect(await service.koalaOf('u1')).toBeUndefined();
      await service.report(placed.instanceId, placed.credential, { status: 'ready', url: 'https://luno.koala.dev' });
      expect(await service.koalaOf('u1')).toEqual({ url: 'https://luno.koala.dev', audience: placed.instanceId });
      expect(await service.koalaOf('someone-else')).toBeUndefined();
    });

    it('keeps the machine\'s credential only as a hash, and answers only to it', async () => {
      const placed = await placedOn('u1');
      const id = placed.instanceId;

      const stored = (await db.instances.getInstances('u1'))[0]!;
      expect(stored.credentialHash).toBeDefined();
      expect(JSON.stringify(stored)).not.toContain(placed.credential);

      expect(await service.release(id, placed.credential)).toMatchObject({ ok: true, value: { imageTag: 'abc123' } });
      expect(await service.release(id, 'guess')).toMatchObject({ ok: false, status: 401 });
      expect(await service.release('inst-someone-else', placed.credential)).toMatchObject({ ok: false, status: 401 });
    });

    it('records what the machine reports, and where the instance answers', async () => {
      const placed = await placedOn('u1');
      const { instanceId, credential } = placed;

      expect(await service.report(instanceId, credential, { status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320/', meshIp: '100.64.0.7' })).toMatchObject({ ok: true });
      expect(await service.mine('u1')).toEqual({ id: instanceId, status: 'ready', detail: 'Installed', url: 'http://100.64.0.7:30320', name: 'luno', install: { id: 'install-u1', machineId: 'm-u1', state: 'asked', at: now.toISOString() }, watch: { notifyWhenUnreachable: true } });
      expect(await service.report(instanceId, credential, { status: 'exploded' })).toMatchObject({ ok: false, status: 400 });
      expect(await service.report(instanceId, credential, { status: 'ready', url: 'javascript:alert(1)' })).toMatchObject({ ok: false, status: 400 });
      expect(await service.report(instanceId, credential, { status: 'ready', url: 'https://luno.koala.dev' })).toMatchObject({ ok: true, value: { url: 'https://luno.koala.dev' } });
    });

    it('never takes an address for the instance that root would call somewhere private, unless it is the instance\'s own mesh address', async () => {
      const placed = await placedOn('u1');
      const { instanceId, credential } = placed;
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
      const placed = await placedOn('u1');
      const { instanceId, credential } = placed;
      expect(await strict.report(instanceId, credential, { status: 'ready', url: 'https://box.example.org' })).toMatchObject({ ok: true, value: { url: 'https://box.example.org' } });
      expect(await strict.report(instanceId, credential, { status: 'ready', url: 'https://rebound.example' })).toMatchObject({ ok: false, status: 400 });
      expect(await lab.report(instanceId, credential, { status: 'ready', url: 'http://127.0.0.1:3001' })).toMatchObject({ ok: true, value: { url: 'http://127.0.0.1:3001' } });
    });

    it('stops watching an instance whose check-in comes from a release that never connects, and keeps one that is connected', async () => {
      const connected = new Set<string>();
      service = new InstanceService(db, { ...settings, connected: (id: string) => connected.has(id) }, mesh, () => now, () => undefined);
      const placed = await placedOn('u1');
      const { instanceId, credential } = placed;
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

    it('will not put Koala on a machine of a root with no mesh or no registry', async () => {
      const machine = { id: 'm-u1', name: 'm', meshIp: '100.64.0.7' };
      const noRegistry = new InstanceService(db, { ...settings, registry: '' }, mesh, () => now);
      const noMesh = new InstanceService(db, { ...settings, meshLoginServer: '' }, mesh, () => now);
      expect(await noRegistry.placeOn('u1', machine, 'luno', 'install-u1')).toMatchObject({ ok: false, status: 503 });
      expect(await noMesh.placeOn('u1', machine, 'luno', 'install-u1')).toMatchObject({ ok: false, status: 503 });
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

  describe('the groups apps are addressed under', () => {
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
      expect(await service.watchAs(instanceId, credential)).toEqual({ ok: true, value: { notifyWhenUnreachable: true } });
      expect(await service.watchAs(instanceId, 'wrong')).toMatchObject({ ok: false, status: 401 });
      expect(await service.setWatchAs(instanceId, credential, 'no')).toMatchObject({ ok: false, status: 400 });
      expect(await service.setWatchAs(instanceId, credential, false)).toEqual({ ok: true, value: { notifyWhenUnreachable: false } });
      expect((await service.mine('u1'))?.watch).toEqual({ notifyWhenUnreachable: false });
      expect(await service.setWatchOf('u1', true)).toMatchObject({ ok: true, value: { notifyWhenUnreachable: true } });
      expect(await service.setWatchOf('nobody', true)).toMatchObject({ ok: false, status: 404 });
      await db.instances.saveReach({ id: instanceId, ownerId: 'u1' }, { reachable: false, unreachableSince: now.toISOString(), toldDown: true });
      expect((await service.mine('u1'))?.watch.reach).toEqual({ reachable: false, unreachableSince: now.toISOString(), toldDown: true });
      await db.instances.deleteInstance(instanceId);
      expect(await db.instances.getWatch(instanceId)).toBeUndefined();
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

    it('puts it again on the same machine, naming the install it replaces, refuses another machine while one holds it and one off the mesh', async () => {
      await service.placeOn('u1', desk, 'luno', 'install-1');
      expect(await service.placeOn('u1', desk, undefined, 'install-2')).toEqual({ ok: true, value: { instanceId: instanceIdFor('u1'), replaces: 'install-1' } });
      expect(await service.placedKoala('install-1', desk)).toMatchObject({ ok: false, status: 404 });
      expect(await service.placedKoala('install-2', { id: 'laptop', name: 'laptop', meshIp: '100.64.0.8' })).toMatchObject({ ok: false, status: 404 });
      expect(await service.placeOn('u1', { id: 'laptop', name: 'laptop', meshIp: '100.64.0.8' }, undefined, 'install-3')).toMatchObject({ ok: false, status: 409, error: 'your Koala is on desk; moving it is a step of its own' });
      expect(await service.placeOn('u2', { id: 'nas', name: 'nas' }, 'nasbox', 'install-4')).toMatchObject({ ok: false, status: 409, error: 'nas is not on your private network yet; Koala is put on it once it is' });
    });

    it('ends an install it could not start as failed, saying why, and shows the person its stage', async () => {
      await service.placeOn('u1', desk, 'luno', 'install-1');
      await service.installNotStarted(instanceIdFor('u1'), 'install-1', 'root could not start putting Koala on desk: Temporal is down');
      expect(await service.placedKoala('install-1', desk)).toMatchObject({ ok: false, status: 404 });
      expect(await service.mine('u1')).toMatchObject({ status: 'failed', detail: 'root could not start putting Koala on desk: Temporal is down', install: { id: 'install-1', machineId: 'desk', state: 'failed', why: 'root could not start putting Koala on desk: Temporal is down' } });
      expect((await service.installsOn('desk')).map((instance) => instance.id)).toEqual([instanceIdFor('u1')]);
    });
  });

  return {
    get db() { return db; },
    get now() { return now; },
    get service() { return service; },
    set service(next: InstanceService) { service = next; },
    placedOn,
  };
}
