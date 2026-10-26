import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { hubRouter } from './hub.js';
import { hubLinkRouter } from './hub-link.js';
import { mountRouter, type Harness, TEST_USER } from '../../platform/routes/test-harness.js';
import { HubService } from '../services/HubService.js';
import { ProjectInviteService } from '../services/ProjectInviteService.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { hashCredential } from '../../instances/services/InstanceService.js';
import type { InviteMetadata } from '../../platform/lib/types.js';

const harnesses: Harness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.close(); });

const ask = { validateStatus: () => true };

async function hubFor(people: { id: string; email: string }[]) {
  const invites: InviteMetadata[] = [];
  const projectInvites = new ProjectInviteService({ invites: { getInviteByCode: async (code) => invites.find((invite) => invite.code === code), saveInvite: async (invite) => { invites.push(invite); } }, rootUrl: 'http://root' });
  const hub = new HubService({ store: memoryHubStore(), invites: projectInvites });
  const sites = [];
  for (const person of people) {
    const site = await mountRouter({ prefix: '/api/hub', user: { ...TEST_USER, ...person }, router: async () => hubRouter({ hub }) });
    harnesses.push(site);
    sites.push(site);
  }
  return { sites, invites, hub };
}

describe('/api/hub', () => {
  it('makes a shared project, invites by email, and lets the person invited in with their role', async () => {
    const { sites: [ann, cy, eve], invites, hub } = await hubFor([{ id: 'ann', email: 'ann@example.com' }, { id: 'cy', email: 'cy@example.com' }, { id: 'eve', email: 'eve@example.com' }]);
    const made = await hub.share({ kind: 'instance', personId: 'ann', instanceId: 'i1', email: 'ann@example.com' }, { name: 'Shop', projectId: 'p1' });
    if (!made.ok) throw new Error(made.why);
    const id = made.value.view.project.id;
    expect((await axios.post(ann!.url('/api/hub/projects'), { name: 'Shop' }, ask)).status).toBe(404);

    const invited = await axios.post(ann!.url(`/api/hub/projects/${id}/invites`), { email: 'cy@example.com', role: 'client' }, ask);
    expect(invited.status).toBe(201);
    expect(invited.data).toMatchObject({ email: 'cy@example.com', role: 'client', emailed: false, why: 'this root sends no email' });
    const join = invites[0]!.project!.join;
    expect((invited.data as { link: string }).link).toBe(`http://root/#/join?code=${encodeURIComponent(invites[0]!.code)}&project=${join}`);

    expect((await axios.post(eve!.url(`/api/hub/invitations/${join}/accept`), {}, ask)).status).toBe(403);
    expect((await axios.get(cy!.url(`/api/hub/invitations/${join}`))).data).toEqual({ projectName: 'Shop', role: 'client', email: 'cy@example.com', forYou: true });
    expect((await axios.post(cy!.url(`/api/hub/invitations/${join}/accept`))).data).toMatchObject({ role: 'client', can: ['see-project', 'see-people', 'pin-and-comment', 'ask-koala'] });
    expect((await axios.get(cy!.url('/api/hub/projects'))).data).toMatchObject([{ project: { name: 'Shop' }, role: 'client' }]);
  });

  it('shows someone not on a project nothing of it, and lets no client invite or change roles', async () => {
    const { sites: [ann, cy, eve], invites, hub } = await hubFor([{ id: 'ann', email: 'ann@example.com' }, { id: 'cy', email: 'cy@example.com' }, { id: 'eve', email: 'eve@example.com' }]);
    const made = await hub.share({ kind: 'instance', personId: 'ann', instanceId: 'i1', email: 'ann@example.com' }, { name: 'Shop', projectId: 'p1' });
    if (!made.ok) throw new Error(made.why);
    const id = made.value.view.project.id;
    await axios.post(ann!.url(`/api/hub/projects/${id}/invites`), { email: 'cy@example.com', role: 'client' });
    await axios.post(cy!.url(`/api/hub/invitations/${invites[0]!.project!.join}/accept`));

    for (const answer of [await axios.get(eve!.url(`/api/hub/projects/${id}`), ask), await axios.put(eve!.url(`/api/hub/projects/${id}/members/ann`), { role: 'client' }, ask), await axios.delete(eve!.url(`/api/hub/projects/${id}/members/ann`), ask)]) {
      expect(answer.status).toBe(404);
    }
    expect((await axios.post(cy!.url(`/api/hub/projects/${id}/invites`), { email: 'dee@example.com', role: 'owner' }, ask)).status).toBe(403);
    expect((await axios.put(cy!.url(`/api/hub/projects/${id}/members/cy`), { role: 'owner' }, ask)).status).toBe(403);
    expect((await axios.delete(cy!.url(`/api/hub/projects/${id}/members/cy`), ask)).data).toEqual({ removed: 'cy' });
  });
});

describe('/api/hub-link, on root', () => {
  async function root() {
    const invites: InviteMetadata[] = [];
    const site = await mountRouter({
      prefix: '/api/hub-link',
      router: async () => hubLinkRouter({ invites: new ProjectInviteService({ invites: { getInviteByCode: async (code) => invites.find((invite) => invite.code === code), saveInvite: async (invite) => { invites.push(invite); } }, rootUrl: 'http://root' }), credentialHash: hashCredential('the-hub'), hash: hashCredential }),
    });
    harnesses.push(site);
    return { site, invites };
  }
  const invite = { email: 'cy@example.com', inviterId: 'ann', inviterEmail: 'ann@example.com', projectName: 'Shop', role: 'client', join: 'J'.repeat(32) };

  it('sends an invite only for its own hub, and shows it to whoever holds its code', async () => {
    const { site, invites } = await root();
    expect((await axios.post(site.url('/api/hub-link/invite'), invite, ask)).status).toBe(401);
    expect((await axios.post(site.url('/api/hub-link/invite'), invite, { ...ask, headers: { authorization: 'Bearer someone-else' } })).status).toBe(401);
    const sent = await axios.post(site.url('/api/hub-link/invite'), invite, { headers: { authorization: 'Bearer the-hub' } });
    expect(sent.status).toBe(201);
    expect((await axios.get(site.url(`/api/hub-link/invitation?code=${encodeURIComponent(invites[0]!.code)}`))).data).toEqual({ email: 'cy@example.com', project: { name: 'Shop', role: 'client', join: 'J'.repeat(32) }, used: false });
    expect((await axios.get(site.url('/api/hub-link/invitation?code=nope'), ask)).status).toBe(404);
  });
});

describe('/api/hub-root, on the hub', () => {
  it('tells only root what a person is on, and lets them go only when root asks and nothing stops it', async () => {
    const { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } = await import('../../instances/lib/identity-token.js');
    const { hubRootRouter } = await import('./hub-root.js');
    const { hubPersonPart, RemoteHubPeople } = await import('../services/HubPeople.js');
    const root = identityKeysFrom(generateIdentityKey());
    const stranger = identityKeysFrom(generateIdentityKey());
    const store = memoryHubStore();
    const tokens: string[] = [];
    const hub = new HubService({ store, invites: { send: async (request) => { tokens.push(request.join); return { link: 'l', emailed: false }; } } });
    const forgotten: string[] = [];
    const site = await mountRouter({ prefix: '/api/hub-root', router: async () => hubRootRouter({ hub, trusted: trustedKeys([publicKeyPem(root.publicKey)]), forget: async (id) => { forgotten.push(id); } }) });
    harnesses.push(site);
    const ann = { id: 'ann', email: 'ann@example.com' };
    const shop = await hub.create(ann, { name: 'Shop' });
    if (!shop.ok) throw new Error(shop.why);
    await hub.invite(ann, shop.value.project.id, { email: 'bo@example.com', role: 'client' });
    await hub.accept({ id: 'bo', email: 'bo@example.com' }, tokens[0]!);

    const people = new RemoteHubPeople({ url: site.url(''), signing: root });
    expect(await people.blockers('ann')).toEqual(['you are the only owner of the shared project "Shop", which others are on; make one of them an owner first']);
    await expect(people.letGo('ann')).rejects.toThrow(/409/);
    for (const token of ['', issueMoveToken(stranger, 'hub', hubPersonPart('bo', 'let-go')), issueMoveToken(root, 'hub', hubPersonPart('ann', 'let-go')), issueMoveToken(root, 'hub', hubPersonPart('bo', 'leaving')), issueMoveToken(root, 'inst-1', hubPersonPart('bo', 'let-go'))]) {
      expect((await axios.delete(site.url('/api/hub-root/people/bo'), { ...ask, headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    }
    expect(await people.blockers('bo')).toEqual([]);
    await people.letGo('bo');
    expect([forgotten, await hub.mine('bo')]).toEqual([['bo'], []]);
  });
});

describe('/api/hub-instance, on the hub', () => {
  it('lets an instance root vouches for share, sync and take back, and turns away a token for anyone else', async () => {
    const { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } = await import('../../instances/lib/identity-token.js');
    const { hubInstanceRouter } = await import('./hub-instance.js');
    const { RemoteHub } = await import('../services/HubRemote.js');
    const { HUB_AUDIENCE, hubInstancePart } = await import('../lib/hub.js');
    const root = identityKeysFrom(generateIdentityKey());
    const store = memoryHubStore();
    const hub = new HubService({ store, invites: { send: async () => ({ link: 'l', emailed: false }) } });
    const site = await mountRouter({ prefix: '/api/hub-instance', router: async () => hubInstanceRouter({ hub, trusted: trustedKeys([publicKeyPem(root.publicKey)]) }) });
    harnesses.push(site);
    const accessFor = (person: string, email: string, signer = root) => ({
      access: async () => ({ token: issueMoveToken(signer, HUB_AUDIENCE, hubInstancePart('inst-ann', person, email)), hubUrl: site.url(''), personId: person, email, instanceId: 'inst-ann' }),
    });
    const remote = new RemoteHub(accessFor('ann', 'ann@example.com'));

    expect(await remote.reachable()).toBe(true);
    const shared = await remote.share({ id: 'ann', email: 'ann@example.com' }, { id: 'p1', name: 'Shop', group: 'acme' });
    const link = { projectId: 'p1', ownerId: 'ann', hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: 't' };
    expect(await remote.push(link, [{ kind: 'leaves', id: 'l1', patch: { set: { title: 'Checkout' } } }])).toEqual({ through: 1 });
    expect((await remote.pull(link, 0)).changes.map((entry) => entry.origin)).toEqual(['instance:inst-ann']);
    expect((await hub.mine('ann'))[0]?.project).toMatchObject({ origin: { instanceId: 'inst-ann', projectId: 'p1' }, group: 'acme' });

    const forged = new RemoteHub(accessFor('ann', 'ann@example.com', identityKeysFrom(generateIdentityKey())));
    await expect(forged.push(link, [])).rejects.toThrow(/401/);
    const someoneElse = new RemoteHub({ access: async () => ({ ...(await accessFor('eve', 'eve@example.com').access()), personId: 'ann' }) });
    await expect(someoneElse.push(link, [])).rejects.toThrow(/401/);
    await expect(new RemoteHub(accessFor('eve', 'eve@example.com')).pull(link, 0)).rejects.toThrow(/404/);

    await remote.unshare('ann', shared.hubProjectId);
    expect(await hub.mine('ann')).toEqual([]);
    await remote.unshare('ann', shared.hubProjectId);
  });
});

describe('relaying a member\'s file to and from the owner\'s instance over HTTP', () => {
  it('streams a member\'s upload to the instance and the instance\'s file back to the member, byte for byte', async () => {
    const { Readable } = await import('node:stream');
    const { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } = await import('../../instances/lib/identity-token.js');
    const { hubInstanceRouter } = await import('./hub-instance.js');
    const { RemoteHub } = await import('../services/HubRemote.js');
    const { HubRelay } = await import('../services/HubRelay.js');
    const { HUB_AUDIENCE, hubInstancePart } = await import('../lib/hub.js');
    const root = identityKeysFrom(generateIdentityKey());
    const relay = new HubRelay(Date.now, 60_000);
    const hub = new HubService({ store: memoryHubStore(), invites: { send: async () => ({ link: 'l', emailed: false }) }, relay });
    const forInstance = await mountRouter({ prefix: '/api/hub-instance', router: async () => hubInstanceRouter({ hub, trusted: trustedKeys([publicKeyPem(root.publicKey)]) }) });
    const forAnn = await mountRouter({ prefix: '/api/hub', user: { ...TEST_USER, id: 'ann', email: 'ann@example.com' }, router: async () => hubRouter({ hub }) });
    harnesses.push(forInstance, forAnn);
    const remote = new RemoteHub({ access: async () => ({ token: issueMoveToken(root, HUB_AUDIENCE, hubInstancePart('inst-ann', 'ann', 'ann@example.com')), hubUrl: forInstance.url(''), personId: 'ann', email: 'ann@example.com', instanceId: 'inst-ann' }) });
    const shared = await remote.share({ id: 'ann', email: 'ann@example.com' }, { id: 'p1', name: 'Shop', group: 'acme' });
    const link = { projectId: 'p1', ownerId: 'ann', hubProjectId: shared.hubProjectId, pulledThrough: 0, sharedAt: 't' };

    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, at) => at % 251));
    const kept: Buffer[] = [];
    const stop = new AbortController();
    const instance = (async () => {
      while (!stop.signal.aborted) {
        const call = await remote.take(link, stop.signal).catch(() => undefined);
        if (!call) continue;
        if (call.op === 'files.upload') {
          const chunks: Buffer[] = [];
          for await (const chunk of await call.upload!.open()) chunks.push(Buffer.from(chunk as Buffer));
          kept.push(Buffer.concat(chunks));
          await remote.answer(link, call.id, { kind: 'json', status: 201, body: { path: call.args.path } });
        } else {
          await remote.answer(link, call.id, { kind: 'stream', status: 200, type: 'application/pdf', name: 'nda.pdf', size: kept[0]!.length, stream: Readable.from([kept[0]!]) });
        }
      }
    })();
    await until(() => relay.online(shared.hubProjectId));

    const put = await axios.put(forAnn.url(`/api/hub/projects/${shared.hubProjectId}/files/content?path=contracts/nda.pdf`), bytes, { ...ask, headers: { 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf' } });
    expect([put.status, put.data]).toEqual([201, { path: 'contracts/nda.pdf' }]);
    expect(kept[0]!.equals(bytes)).toBe(true);
    const got = await axios.get(forAnn.url(`/api/hub/projects/${shared.hubProjectId}/files/content?path=contracts/nda.pdf`), { ...ask, responseType: 'arraybuffer' });
    expect([got.status, got.headers['content-type'], Buffer.from(got.data as ArrayBuffer).equals(bytes)]).toEqual([200, 'application/pdf', true]);

    stop.abort();
    await instance;
    relay.stop();
  });
});

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !ready(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}
