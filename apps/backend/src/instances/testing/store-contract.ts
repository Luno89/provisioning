import { describe, expect, it } from 'vitest';
import type { InstanceRecord } from '../lib/instances.js';
import type { DependencyFinding } from '../lib/dependency-findings.js';
import type { LogoutDelivery } from '../lib/sign-in-state.js';
import type { InstancesStore } from '../store.js';

const instance = (id: string, ownerId: string, more: Partial<InstanceRecord> = {}): InstanceRecord =>
  ({ id, ownerId, url: `https://${id}.example`, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...more });

const key = (kid: string) => ({ jwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: `x-${kid}`, kid }, since: '2026-10-05T00:00:00.000Z' });

const logout = (id: string, revokedAt: string): LogoutDelivery =>
  ({ id, clientId: 'client', url: `https://client.example/${id}`, subject: 'person', revokedAt, why: 'signed-out-everywhere' });

const finding = (key: string, more: Partial<DependencyFinding> = {}): DependencyFinding => ({
  key,
  component: { name: 'left-pad', version: '1.0.0', kind: 'npm' },
  advisory: { id: `GHSA-${key}` },
  state: 'waiting',
  releases: ['v1'],
  instances: [],
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  told: {},
  ...more,
});

const release = (imageTag: string, more: Record<string, unknown> = {}) => ({ imageTag, version: `v-${imageTag}`, servedAt: '2026-10-10T00:00:00.000Z', ...more });

export function instancesStoreContract(make: () => Promise<InstancesStore>): void {

  describe('the instance registry', () => {
    it('keeps an instance as saved, replaces it whole when saved again and forgets it when deleted', async () => {
      const store = await make();
      await store.saveInstance(instance('alpha', 'owner-1', { name: 'alpha', detail: 'installing', meshIp: '100.64.0.2', addresses: { nested: true, state: 'issuing' } }));
      await store.saveInstance(instance('beta', 'owner-2'));
      expect(await store.getInstances()).toEqual(expect.arrayContaining([
        instance('alpha', 'owner-1', { name: 'alpha', detail: 'installing', meshIp: '100.64.0.2', addresses: { nested: true, state: 'issuing' } }),
        instance('beta', 'owner-2'),
      ]));
      await store.saveInstance(instance('alpha', 'owner-1', { url: 'https://moved.example' }));
      const replaced = (await store.getInstances()).find((one) => one.id === 'alpha');
      expect(replaced).toEqual(instance('alpha', 'owner-1', { url: 'https://moved.example' }));
      expect(replaced).not.toHaveProperty('detail');
      await store.deleteInstance('alpha');
      await store.deleteInstance('never-there');
      expect((await store.getInstances()).map((one) => one.id)).toEqual(['beta']);
    });

    it('lists one owner\'s instances, or everyone\'s when no owner is named', async () => {
      const store = await make();
      await store.saveInstance(instance('a', 'owner-1'));
      await store.saveInstance(instance('b', 'owner-2'));
      await store.saveInstance(instance('c', 'owner-1'));
      expect((await store.getInstances('owner-1')).map((one) => one.id).sort()).toEqual(['a', 'c']);
      expect((await store.getInstances('nobody'))).toEqual([]);
      expect((await store.getInstances()).map((one) => one.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveInstance(instance('a', 'owner-1', { groups: [{ projectId: 'p', name: 'g' }] }));
      const [read] = await store.getInstances();
      read!.url = 'changed';
      read!.groups!.push({ projectId: 'q', name: 'h' });
      const [again] = await store.getInstances();
      expect(again?.url).toBe('https://a.example');
      expect(again?.groups).toEqual([{ projectId: 'p', name: 'g' }]);
    });

    it('stamps when an instance was first served the moment it is saved ready, and keeps the first stamp', async () => {
      const store = await make();
      await store.saveInstance(instance('a', 'o', { status: 'installing' }));
      expect((await store.getInstances())[0]).not.toHaveProperty('servedAt');
      await store.saveInstance(instance('a', 'o', { status: 'ready', updatedAt: '2026-10-03T00:00:00.000Z' }));
      expect((await store.getInstances())[0]).toHaveProperty('servedAt', '2026-10-03T00:00:00.000Z');
      await store.saveInstance(instance('a', 'o', { status: 'ready', updatedAt: '2026-10-09T00:00:00.000Z', servedAt: '2026-10-03T00:00:00.000Z' }));
      expect((await store.getInstances())[0]).toHaveProperty('servedAt', '2026-10-03T00:00:00.000Z');
    });

    it('keeps an instance\'s name to one instance, and lets nameless instances be many', async () => {
      const store = await make();
      await store.saveInstance(instance('a', 'o', { name: 'shop' }));
      await expect(store.saveInstance(instance('b', 'o', { name: 'shop' }))).rejects.toThrow();
      await store.saveInstance(instance('a', 'o', { name: 'shop', url: 'https://again.example' }));
      await store.saveInstance(instance('c', 'o'));
      await store.saveInstance(instance('d', 'o'));
      expect((await store.getInstances()).map((one) => one.id).sort()).toEqual(['a', 'c', 'd']);
      await store.deleteInstance('a');
      await store.saveInstance(instance('b', 'o', { name: 'shop' }));
      expect((await store.getInstances()).find((one) => one.id === 'b')?.name).toBe('shop');
    });

    it('names an instance\'s sign-in key only where the instance exists, and says whether it did', async () => {
      const store = await make();
      expect(await store.saveSignInKey('gone', key('k0'))).toBe(false);
      expect(await store.getInstances()).toEqual([]);
      await store.saveInstance(instance('a', 'o'));
      expect(await store.saveSignInKey('a', key('k1'))).toBe(true);
      expect((await store.getInstances())[0]?.signIn).toEqual(key('k1'));
      expect(await store.saveSignInKey('a', key('k2'))).toBe(true);
      expect((await store.getInstances())[0]?.signIn).toEqual(key('k2'));
    });

    it('leaves out a field saved as undefined', async () => {
      const store = await make();
      await store.saveInstance(instance('a', 'o', { detail: undefined }));
      expect((await store.getInstances())[0]).not.toHaveProperty('detail');
    });
  });

  describe('following Koala being put on a machine', () => {
    it('hears each write of an instance with an install, and none of one without', async () => {
      const store = await make();
      const heard: string[] = [];
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const watching = store.watchInstalls((written) => { heard.push(`${written.id} ${written.install?.state}`); if (written.install?.state === 'ready') finish(); });
      await watching.ready;
      const install = { id: 'install-1', machineId: 'desk', state: 'asked' as const, askedAt: '2026-11-18T10:00:00.000Z', at: '2026-11-18T10:00:00.000Z' };
      await store.saveInstance(instance('inst-plain', 'o1'));
      await store.saveInstance(instance('inst-installed', 'o2', { install }));
      await store.saveInstance(instance('inst-installed', 'o2', { install: { ...install, state: 'ready' } }));
      await done;
      await watching.close();
      expect(heard).toEqual(['inst-installed asked', 'inst-installed ready']);
    });

    it('hears each write of an instance being put on a machine, which its owner\'s page follows', async () => {
      const store = await make();
      const heard: string[] = [];
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const watching = store.watchInstalls((written) => { heard.push(`${written.id} ${written.install?.state}`); if (written.install?.state === 'failed') finish(); });
      await watching.ready;
      const install = { id: 'install-1', machineId: 'desk', at: '2026-11-18T10:00:00.000Z' };
      await store.saveInstance(instance('inst-plain', 'o1'));
      await store.saveInstance(instance('inst-put', 'o2', { install: { ...install, state: 'asked' }, status: 'joined' }));
      await store.saveInstance(instance('inst-put', 'o2', { install: { ...install, state: 'installing' }, status: 'installing' }));
      await store.saveInstance(instance('inst-put', 'o2', { install: { ...install, state: 'failed' }, status: 'failed' }));
      await done;
      await watching.close();
      expect(heard).toEqual(['inst-put asked', 'inst-put installing', 'inst-put failed']);
    });

    it('changes only the fields named, only while the install named is the instance\'s, and stamps when it first served once ready', async () => {
      const store = await make();
      const install = { id: 'install-1', machineId: 'desk', state: 'asked' as const, line: 'waiting', askedAt: '2026-11-18T10:00:00.000Z', at: '2026-11-18T10:00:00.000Z' };
      await store.saveInstance(instance('inst-a', 'o1', { install, credentialHash: 'h1' }));
      expect(await store.updateInstall('inst-a', 'install-0', { status: 'failed' })).toBe(false);
      expect(await store.updateInstall('inst-a', 'install-1', { 'install.state': 'installing', 'install.line': undefined, status: 'installing', updatedAt: '2026-11-18T10:01:00.000Z' })).toBe(true);
      expect((await store.getInstances('o1'))[0]).toEqual(instance('inst-a', 'o1', { install: { id: 'install-1', machineId: 'desk', state: 'installing', askedAt: install.askedAt, at: install.at }, credentialHash: 'h1', status: 'installing', updatedAt: '2026-11-18T10:01:00.000Z' }));
      expect(await store.updateInstall('inst-a', 'install-1', { 'install.state': 'ready', status: 'ready', url: 'https://bo.koala.app', updatedAt: '2026-11-18T10:02:00.000Z' })).toBe(true);
      expect((await store.getInstances('o1'))[0]).toMatchObject({ status: 'ready', url: 'https://bo.koala.app', servedAt: '2026-11-18T10:02:00.000Z', credentialHash: 'h1' });
      expect(await store.updateInstall('inst-missing', 'install-1', { status: 'ready' })).toBe(false);
    });
  });

  describe('watching whether an instance can be reached', () => {
    it('keeps what is known of each instance apart, and says nothing of the owner', async () => {
      const store = await make();
      expect(await store.getWatch('a')).toBeUndefined();
      expect(await store.getWatches()).toEqual([]);
      await store.saveReach({ id: 'a', ownerId: 'owner-1' }, { reachable: false, unreachableSince: '2026-10-10T00:00:00.000Z', toldDown: true });
      await store.savePresence({ id: 'a', ownerId: 'owner-1' }, true);
      await store.saveNotifyWhenUnreachable({ id: 'b', ownerId: 'owner-2' }, false);
      expect(await store.getWatch('a')).toEqual({ instanceId: 'a', reach: { reachable: false, unreachableSince: '2026-10-10T00:00:00.000Z', toldDown: true }, presence: true });
      expect(await store.getWatch('b')).toEqual({ instanceId: 'b', notifyWhenUnreachable: false });
      expect(await store.getWatches()).toEqual(expect.arrayContaining([
        { instanceId: 'a', reach: { reachable: false, unreachableSince: '2026-10-10T00:00:00.000Z', toldDown: true }, presence: true },
        { instanceId: 'b', notifyWhenUnreachable: false },
      ]));
      expect(await store.getWatches()).toHaveLength(2);
    });

    it('changes one thing at a time, leaving the others, and replaces a reach whole', async () => {
      const store = await make();
      const owner = { id: 'a', ownerId: 'o' };
      await store.saveReach(owner, { reachable: true, lastSeenAt: '2026-10-10T00:00:00.000Z' });
      await store.savePresence(owner, true);
      await store.saveNotifyWhenUnreachable(owner, true);
      await store.savePresence(owner, false);
      await store.saveReach(owner, { reachable: false });
      const watch = await store.getWatch('a');
      expect(watch).toEqual({ instanceId: 'a', reach: { reachable: false }, presence: false, notifyWhenUnreachable: true });
      expect(watch?.reach).not.toHaveProperty('lastSeenAt');
    });

    it('forgets a watch when it is deleted, and when its instance is deleted', async () => {
      const store = await make();
      await store.saveInstance(instance('a', 'o'));
      await store.savePresence({ id: 'a', ownerId: 'o' }, true);
      await store.savePresence({ id: 'b', ownerId: 'o' }, true);
      await store.deleteInstance('a');
      expect(await store.getWatch('a')).toBeUndefined();
      await store.deleteWatch('b');
      await store.deleteWatch('never');
      expect(await store.getWatches()).toEqual([]);
    });

    it('hands back a copy', async () => {
      const store = await make();
      await store.saveReach({ id: 'a', ownerId: 'o' }, { reachable: true });
      const read = await store.getWatch('a');
      read!.reach!.reachable = false;
      expect((await store.getWatch('a'))?.reach?.reachable).toBe(true);
    });
  });

  describe('the releases root has run', () => {
    it('records a release and gives back what is stored', async () => {
      const store = await make();
      expect(await store.getReleases()).toEqual([]);
      const recorded = await store.recordRelease(release('t1', { notes: 'first', digest: 'sha256:abc', chartSha256: 'def', hotfix: true, dataVersion: 1 }));
      expect(recorded).toEqual(release('t1', { notes: 'first', digest: 'sha256:abc', chartSha256: 'def', hotfix: true, dataVersion: 1 }));
      expect(await store.getReleases()).toEqual([recorded]);
    });

    it('records the same release again without moving when it was first served, dropping the optional parts it no longer has', async () => {
      const store = await make();
      await store.recordRelease(release('t1', { notes: 'n', hotfix: true, digest: 'd', chartSha256: 'c', dataVersion: 1 }));
      const again = await store.recordRelease({ imageTag: 't1', version: 'v2', servedAt: '2026-11-01T00:00:00.000Z', digest: 'd2' });
      expect(again).toEqual({ imageTag: 't1', version: 'v2', servedAt: '2026-10-10T00:00:00.000Z', digest: 'd2' });
      expect(await store.getReleases()).toEqual([again]);
    });

    it('keeps a withdrawal when the release is recorded again', async () => {
      const store = await make();
      await store.recordRelease(release('t1'));
      await store.withdrawRelease('t1', { at: '2026-10-11T00:00:00.000Z', by: 'v0' });
      const again = await store.recordRelease(release('t1', { notes: 'n' }));
      expect(again.withdrawn).toEqual({ at: '2026-10-11T00:00:00.000Z', by: 'v0' });
    });

    it('withdraws a release and takes the withdrawal back, touching no other release and none that is not there', async () => {
      const store = await make();
      await store.recordRelease(release('t1'));
      await store.recordRelease(release('t2'));
      await store.withdrawRelease('t1', { at: 'a', by: 'b' });
      await store.withdrawRelease('missing', { at: 'a', by: 'b' });
      const withdrawn = await store.getReleases();
      expect(withdrawn.find((one) => one.imageTag === 't1')?.withdrawn).toEqual({ at: 'a', by: 'b' });
      expect(withdrawn.find((one) => one.imageTag === 't2')).not.toHaveProperty('withdrawn');
      expect(withdrawn.map((one) => one.imageTag).sort()).toEqual(['t1', 't2']);
      await store.withdrawRelease('t1', undefined);
      expect((await store.getReleases()).find((one) => one.imageTag === 't1')).not.toHaveProperty('withdrawn');
    });

    it('tells a withdrawal once per key', async () => {
      const store = await make();
      expect(await store.withdrawalTold('k')).toBe(false);
      await store.recordWithdrawalTold('k', 'owner-1', '2026-10-10T00:00:00.000Z');
      await store.recordWithdrawalTold('k', 'owner-2', '2026-10-11T00:00:00.000Z');
      expect(await store.withdrawalTold('k')).toBe(true);
      expect(await store.withdrawalTold('other')).toBe(false);
    });

    it('records a release carrying an optional field set to undefined, leaving the field out', async () => {
      const store = await make();
      await store.recordRelease(release('t1', { notes: 'first' }));
      await store.recordRelease(release('t1', { notes: undefined }));
      expect((await store.getReleases())[0]).not.toHaveProperty('notes');
    });
  });

  describe('what the OpenID provider keeps', () => {
    it('finds an artifact by model and id as it was saved, replaces it whole and forgets it when destroyed', async () => {
      const store = await make();
      await store.oidcUpsert('Session', 's1', { uid: 'u1', loginTs: 1 }, 600);
      await store.oidcUpsert('AccessToken', 's1', { jti: 'other model' });
      expect(await store.oidcFind('Session', 's1')).toEqual({ uid: 'u1', loginTs: 1 });
      expect(await store.oidcFind('AccessToken', 's1')).toEqual({ jti: 'other model' });
      expect(await store.oidcFind('Session', 'missing')).toBeUndefined();
      await store.oidcUpsert('Session', 's1', { uid: 'u1', loginTs: 2 });
      expect(await store.oidcFind('Session', 's1')).toEqual({ uid: 'u1', loginTs: 2 });
      await store.oidcDestroy('Session', 's1');
      await store.oidcDestroy('Session', 'never');
      expect(await store.oidcFind('Session', 's1')).toBeUndefined();
      expect(await store.oidcFind('AccessToken', 's1')).toBeDefined();
    });

    it('finds an artifact by its uid or its user code within its model only', async () => {
      const store = await make();
      await store.oidcUpsert('Interaction', 'i1', { uid: 'shared', note: 'interaction' });
      await store.oidcUpsert('Session', 's1', { uid: 'shared', note: 'session' });
      await store.oidcUpsert('DeviceCode', 'd1', { userCode: 'ABCD-EFGH', note: 'device' });
      expect(await store.oidcFindBy('Interaction', 'uid', 'shared')).toEqual({ uid: 'shared', note: 'interaction' });
      expect(await store.oidcFindBy('Session', 'uid', 'shared')).toEqual({ uid: 'shared', note: 'session' });
      expect(await store.oidcFindBy('DeviceCode', 'userCode', 'ABCD-EFGH')).toEqual({ userCode: 'ABCD-EFGH', note: 'device' });
      expect(await store.oidcFindBy('DeviceCode', 'uid', 'ABCD-EFGH')).toBeUndefined();
      expect(await store.oidcFindBy('Session', 'userCode', 'shared')).toBeUndefined();
      expect(await store.oidcFindBy('Session', 'uid', 'nobody')).toBeUndefined();
    });

    it('stops finding an artifact by a uid it was saved over without', async () => {
      const store = await make();
      await store.oidcUpsert('Session', 's1', { uid: 'old' });
      await store.oidcUpsert('Session', 's1', { uid: 'new' });
      expect(await store.oidcFindBy('Session', 'uid', 'old')).toBeUndefined();
      expect(await store.oidcFindBy('Session', 'uid', 'new')).toEqual({ uid: 'new' });
      await store.oidcUpsert('Session', 's1', { other: true });
      expect(await store.oidcFindBy('Session', 'uid', 'new')).toBeUndefined();
    });

    it('marks an artifact consumed with the time in seconds, and ignores one that is not there', async () => {
      const store = await make();
      await store.oidcUpsert('AuthorizationCode', 'c1', { grantId: 'g', clientId: 'x' });
      const before = Math.floor(Date.now() / 1000);
      await store.oidcConsume('AuthorizationCode', 'c1');
      await store.oidcConsume('AuthorizationCode', 'never');
      const consumed = await store.oidcFind('AuthorizationCode', 'c1');
      expect(consumed).toMatchObject({ grantId: 'g', clientId: 'x' });
      expect(consumed?.consumed).toBeGreaterThanOrEqual(before);
      expect(consumed?.consumed).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      expect(await store.oidcFind('AuthorizationCode', 'never')).toBeUndefined();
    });

    it('revokes a grant with everything issued under it and nothing else', async () => {
      const store = await make();
      await store.oidcUpsert('Grant', 'g1', { accountId: 'p1', clientId: 'c1' });
      await store.oidcUpsert('AccessToken', 'a1', { grantId: 'g1' });
      await store.oidcUpsert('RefreshToken', 'r1', { grantId: 'g1' });
      await store.oidcUpsert('Grant', 'g2', { accountId: 'p1', clientId: 'c2' });
      await store.oidcUpsert('AccessToken', 'a2', { grantId: 'g2' });
      await store.oidcRevokeGrant('g1');
      await store.oidcRevokeGrant('never');
      expect(await store.oidcFind('Grant', 'g1')).toBeUndefined();
      expect(await store.oidcFind('AccessToken', 'a1')).toBeUndefined();
      expect(await store.oidcFind('RefreshToken', 'r1')).toBeUndefined();
      expect(await store.oidcFind('Grant', 'g2')).toBeDefined();
      expect(await store.oidcFind('AccessToken', 'a2')).toBeDefined();
    });

    it('forgets an account\'s artifacts and the tokens of its grants, and names the clients it had grants with once each', async () => {
      const store = await make();
      await store.oidcUpsert('Grant', 'g1', { accountId: 'p1', clientId: 'c1' });
      await store.oidcUpsert('Grant', 'g2', { accountId: 'p1', clientId: 'c1' });
      await store.oidcUpsert('Grant', 'g3', { accountId: 'p1', clientId: 'c2' });
      await store.oidcUpsert('AccessToken', 'a1', { grantId: 'g1' });
      await store.oidcUpsert('Session', 's1', { accountId: 'p1' });
      await store.oidcUpsert('Grant', 'g9', { accountId: 'p2', clientId: 'c9' });
      await store.oidcUpsert('AccessToken', 'a9', { grantId: 'g9' });
      expect((await store.oidcForgetAccount('p1')).sort()).toEqual(['c1', 'c2']);
      for (const [model, id] of [['Grant', 'g1'], ['Grant', 'g2'], ['Grant', 'g3'], ['AccessToken', 'a1'], ['Session', 's1']] as const) {
        expect(await store.oidcFind(model, id)).toBeUndefined();
      }
      expect(await store.oidcFind('Grant', 'g9')).toBeDefined();
      expect(await store.oidcFind('AccessToken', 'a9')).toBeDefined();
      expect(await store.oidcForgetAccount('p1')).toEqual([]);
    });
  });

  describe('logouts waiting to be delivered', () => {
    it('lists them oldest revocation first and drops one once delivered', async () => {
      const store = await make();
      await store.enqueueLogout(logout('late', '2026-10-12T00:00:00.000Z'));
      await store.enqueueLogout(logout('early', '2026-10-10T00:00:00.000Z'));
      await store.enqueueLogout(logout('middle', '2026-10-11T00:00:00.000Z'));
      expect((await store.pendingLogouts()).map((one) => one.id)).toEqual(['early', 'middle', 'late']);
      expect((await store.pendingLogouts())[0]).toEqual(logout('early', '2026-10-10T00:00:00.000Z'));
      await store.logoutDelivered('middle');
      await store.logoutDelivered('never');
      expect((await store.pendingLogouts()).map((one) => one.id)).toEqual(['early', 'late']);
    });

    it('replaces a logout queued again under the same id', async () => {
      const store = await make();
      await store.enqueueLogout(logout('a', '2026-10-10T00:00:00.000Z'));
      await store.enqueueLogout({ ...logout('a', '2026-10-10T00:00:00.000Z'), subject: 'someone else' });
      const pending = await store.pendingLogouts();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.subject).toBe('someone else');
    });

    it('counts each failed attempt with its reason and time, and ignores a failure of one that is gone', async () => {
      const store = await make();
      await store.enqueueLogout(logout('a', '2026-10-10T00:00:00.000Z'));
      await store.logoutFailed('a', 'connection refused', '2026-10-10T00:01:00.000Z');
      await store.logoutFailed('a', 'timed out', '2026-10-10T00:02:00.000Z');
      await store.logoutFailed('never', 'nothing', '2026-10-10T00:03:00.000Z');
      expect(await store.pendingLogouts()).toEqual([{ ...logout('a', '2026-10-10T00:00:00.000Z'), attempts: 2, lastError: 'timed out', lastTriedAt: '2026-10-10T00:02:00.000Z' }]);
    });

    it('counts a failure against a logout queued with attempts left undefined from one', async () => {
      const store = await make();
      await store.enqueueLogout({ ...logout('a', '2026-10-10T00:00:00.000Z'), attempts: undefined });
      await store.logoutFailed('a', 'e', 't');
      expect((await store.pendingLogouts()).find((delivery) => delivery.id === 'a')).toMatchObject({ attempts: 1, lastError: 'e' });
    });
  });

  describe('logouts root sent', () => {
    it('takes a logout token\'s id once, even when it arrives twice at the same moment', async () => {
      const store = await make();
      const until = new Date(Date.now() + 120_000);
      expect(await Promise.all([store.takeLogoutToken('jti-1', until), store.takeLogoutToken('jti-1', until)])).toEqual(expect.arrayContaining([true, false]));
      expect(await store.takeLogoutToken('jti-1', until)).toBe(false);
      expect(await store.takeLogoutToken('jti-2', until)).toBe(true);
    });
  });

  describe('what the dependency watch found', () => {
    it('keeps the findings it was given as given', async () => {
      const store = await make();
      expect(await store.getDependencyFindings()).toEqual([]);
      const first = finding('one', { fix: '1.0.1', fixPublishedAt: '2026-10-01T00:00:00.000Z', takeOn: '2026-10-15', told: { appeared: '2026-10-02T00:00:00.000Z' }, devOnly: true });
      const second = finding('two', { advisory: { id: 'GHSA-2', summary: 'bad', severity: 'high' } });
      await store.saveDependencyFindings([first, second]);
      const stored = await store.getDependencyFindings();
      expect(stored).toHaveLength(2);
      expect(stored).toEqual(expect.arrayContaining([first, second]));
    });

    it('replaces the findings whole: those not given again go, those given are updated, new ones come', async () => {
      const store = await make();
      await store.saveDependencyFindings([finding('keep'), finding('go')]);
      await store.saveDependencyFindings([finding('keep', { state: 'due', fix: '2.0.0' }), finding('new')]);
      const stored = await store.getDependencyFindings();
      expect(stored.map((one) => one.key).sort()).toEqual(['keep', 'new']);
      expect(stored.find((one) => one.key === 'keep')).toEqual(finding('keep', { state: 'due', fix: '2.0.0' }));
      await store.saveDependencyFindings([]);
      expect(await store.getDependencyFindings()).toEqual([]);
    });

    it('drops an optional part of a finding when it is saved again without it', async () => {
      const store = await make();
      await store.saveDependencyFindings([finding('a', { fix: '1.0.1', devOnly: true })]);
      await store.saveDependencyFindings([finding('a')]);
      const [stored] = await store.getDependencyFindings();
      expect(stored).not.toHaveProperty('fix');
      expect(stored).not.toHaveProperty('devOnly');
    });

    it('hands back a copy', async () => {
      const store = await make();
      await store.saveDependencyFindings([finding('a')]);
      const [read] = await store.getDependencyFindings();
      read!.releases.push('v2');
      expect((await store.getDependencyFindings())[0]?.releases).toEqual(['v1']);
    });

    it('keeps the latest check and none before the first', async () => {
      const store = await make();
      expect(await store.getDependencyCheck()).toBeUndefined();
      const check = { checkedAt: '2026-10-10T00:00:00.000Z', releases: [{ release: 'v1', label: 'root', instances: [], root: true, components: 3, inventory: true }], components: [{ name: 'a', kind: 'npm' as const, dev: false, checked: true }], problems: [] };
      await store.saveDependencyCheck(check);
      await store.saveDependencyCheck({ ...check, checkedAt: '2026-10-11T00:00:00.000Z', problems: ['osv unreachable'] });
      expect(await store.getDependencyCheck()).toEqual({ ...check, checkedAt: '2026-10-11T00:00:00.000Z', problems: ['osv unreachable'] });
    });
  });
}
