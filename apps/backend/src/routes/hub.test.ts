import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { hubRouter } from './hub.js';
import { hubLinkRouter } from './hub-link.js';
import { mountRouter, type Harness, TEST_USER } from './test-harness.js';
import { HubService } from '../services/HubService.js';
import { ProjectInviteService } from '../services/ProjectInviteService.js';
import { memoryHubStore } from '../lib/hub-store.js';
import { hashCredential } from '../services/InstanceService.js';
import type { InviteMetadata } from '../lib/types.js';

const harnesses: Harness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.close(); });

const ask = { validateStatus: () => true };

async function hubFor(people: { id: string; email: string }[]) {
  const invites: InviteMetadata[] = [];
  const projectInvites = new ProjectInviteService({ invites: { getInvites: async () => invites, saveInvite: async (invite) => { invites.push(invite); } }, rootUrl: 'http://root' });
  const hub = new HubService({ store: memoryHubStore(), invites: projectInvites });
  const sites = [];
  for (const person of people) {
    const site = await mountRouter({ prefix: '/api/hub', user: { ...TEST_USER, ...person }, router: async () => hubRouter({ hub }) });
    harnesses.push(site);
    sites.push(site);
  }
  return { sites, invites };
}

describe('/api/hub', () => {
  it('makes a shared project, invites by email, and lets the person invited in with their role', async () => {
    const { sites: [ann, cy, eve], invites } = await hubFor([{ id: 'ann', email: 'ann@example.com' }, { id: 'cy', email: 'cy@example.com' }, { id: 'eve', email: 'eve@example.com' }]);
    const made = await axios.post(ann!.url('/api/hub/projects'), { name: 'Shop', origin: { projectId: 'p1' } }, ask);
    expect(made.status).toBe(201);
    const id = (made.data as { project: { id: string } }).project.id;

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
    const { sites: [ann, cy, eve], invites } = await hubFor([{ id: 'ann', email: 'ann@example.com' }, { id: 'cy', email: 'cy@example.com' }, { id: 'eve', email: 'eve@example.com' }]);
    const id = ((await axios.post(ann!.url('/api/hub/projects'), { name: 'Shop' })).data as { project: { id: string } }).project.id;
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
      router: async () => hubLinkRouter({ invites: new ProjectInviteService({ invites: { getInvites: async () => invites, saveInvite: async (invite) => { invites.push(invite); } }, rootUrl: 'http://root' }), credentialHash: hashCredential('the-hub'), hash: hashCredential }),
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
    const { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } = await import('../lib/identity-token.js');
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
