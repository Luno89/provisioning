import { afterEach, describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { HUB_AUDIENCE, hubInstancePart, type HubAccess } from '../lib/hub.js';
import { memoryHubStore } from '../testing/memory-hub-store.js';
import { hubInstanceRouter } from '../routes/hub-instance.js';
import { HubService } from './HubService.js';
import { RemoteHub, RootHubAccess } from './HubRemote.js';

const harnesses: Harness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.close(); });

async function rootWithAHub(hubUrl: (() => string) | undefined) {
  const keys = identityKeysFrom(generateIdentityKey());
  let service: InstanceService | undefined;
  const root = await mountRouter({
    prefix: '/api/instances',
    router: (db) => {
      const mesh = { createPreAuthKey: async () => ({ key: 'mesh-key' }), listUserDevices: async () => [{ ipAddresses: ['100.64.0.9'] }] };
      service = new InstanceService(db, { rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev' }, mesh);
      return instancesRouter({
        instances: service,
        chart: async () => '',
        ...(hubUrl ? { hubAccess: async (instanceId: string, ownerId: string): Promise<HubAccess> => ({ token: issueMoveToken(keys, HUB_AUDIENCE, hubInstancePart(instanceId, ownerId, TEST_USER.email)), hubUrl: hubUrl(), personId: ownerId, email: TEST_USER.email, instanceId }) } : {}),
      });
    },
  });
  harnesses.push(root);
  const made = await service!.createJoinToken(TEST_USER.id, 'luno');
  if (!made.ok) throw new Error(made.error);
  const joined = await service!.join(made.value.token, 'box');
  if (!joined.ok) throw new Error(joined.error);
  return { root, keys, instanceId: joined.value.instanceId, credential: joined.value.credential };
}

describe('an instance asking root for its way to the hub', () => {
  it('is given what root grants its owner, and is told why when root has no hub or does not know the instance', async () => {
    const { root, instanceId, credential } = await rootWithAHub(() => 'https://hub.test');
    const asking = (id: string, secret: string) => new RootHubAccess({ rootUrl: root.url(''), instanceId: id, token: async () => secret });
    expect(await asking(instanceId, credential).access()).toMatchObject({ hubUrl: 'https://hub.test', personId: TEST_USER.id, email: TEST_USER.email, instanceId });
    await expect(asking(instanceId, 'not-the-credential').access()).rejects.toThrow('root gave no way to the hub (401): unknown instance or credential');
    await expect(asking('inst-nobody', credential).access()).rejects.toThrow('root gave no way to the hub (401)');

    const hubless = await rootWithAHub(undefined);
    await expect(new RootHubAccess({ rootUrl: hubless.root.url(''), instanceId: hubless.instanceId, token: async () => hubless.credential }).access()).rejects.toThrow('root gave no way to the hub (404): this root has no hub');
  });
});

describe('the owner\'s instance reaching the hub through root', () => {
  it('shares, reads the requests waiting for the owner, settles them and reports what is live, each call vouched for by root', async () => {
    let hubSite: Harness | undefined;
    const { root, keys, instanceId, credential } = await rootWithAHub(() => hubSite!.url(''));
    const store = memoryHubStore();
    const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) }, now: () => '2026-10-21T00:00:00Z' });
    hubSite = await mountRouter({ db: 'own', prefix: '/api/hub-instance', router: async (db) => hubInstanceRouter({ hub, trusted: trustedKeys([publicKeyPem(keys.publicKey)]), claim: (jti, expiresAt) => db.instances.claimHandoff(jti, expiresAt) }) });
    harnesses.push(hubSite);
    const remote = new RemoteHub(new RootHubAccess({ rootUrl: root.url(''), instanceId, token: async () => credential }));

    const shared = await remote.share({ id: TEST_USER.id, email: TEST_USER.email }, { id: 'p1', name: 'Shop', group: 'acme' });
    const link = { projectId: 'p1', ownerId: TEST_USER.id, hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: 't' };
    const onHub = store.project(shared.hubProjectId);
    await onHub.saveMember({ personId: 'bo', email: 'bo@example.com', role: 'collaborator', joinedAt: 't' });
    await store.addMembership('bo', shared.hubProjectId);
    await onHub.putRecord('branches', { id: 'b1', treeId: 't1' });
    await onHub.putRecord('leaves', { id: 'l1', branchId: 'b1' });
    await onHub.putRecord('leaves', { id: 'l2', branchId: 'b1' });
    const asked = await hub.request({ id: 'bo', email: 'bo@example.com' }, shared.hubProjectId, { kind: 'order-stories', branchId: 'b1', leafIds: ['l2', 'l1'] });
    if (!asked.ok) throw new Error(asked.why);

    expect((await remote.requests(link)).map((request) => [request.id, request.kind, request.state])).toEqual([[asked.value.id, 'order-stories', 'waiting']]);
    await remote.settle(link, asked.value.id, { state: 'refused', why: 'the story moved' });
    expect(await remote.requests(link)).toEqual([]);
    expect((await onHub.requests())[0]).toMatchObject({ state: 'refused', why: 'the story moved' });

    await remote.status(link, { at: 'ignored', releases: [{ id: 'r1' }], runs: [], treeRuns: { t1: { state: 'idle' } } });
    expect(await onHub.status()).toEqual({ at: '2026-10-21T00:00:00Z', releases: [{ id: 'r1' }], runs: [], treeRuns: { t1: { state: 'idle' } } });
    await expect(remote.status(link, { at: 'x' } as never)).rejects.toThrow(/400/);
    await expect(remote.settle(link, 'nope', { state: 'done' })).rejects.toThrow(/404/);
  });
});
