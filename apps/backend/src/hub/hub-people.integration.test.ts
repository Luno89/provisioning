import crypto from 'node:crypto';
import { leaseMongo } from '../platform/lib/mongo-lease.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fetchSide, handOff, sessionFrom, signedInLanding } from '../platform/testing/handoff.js';
import { call, removeAccountOnRoot, startThreeRoles, until, waiting, type Person, type ThreeRoles } from '../platform/testing/three-roles.js';
import { HUB_DATABASE_PREFIX } from './lib/hub.js';
import { HUB_REPO, hubOrgOf } from './services/HubRepos.js';
import { mainHeads } from './services/HubRepoSync.js';

interface Member { name: string; person: Person; hub: string }
interface HubProject { id: string; name: string; onInstance: string }
interface Invited { role: string; link: string; emailed?: boolean; why?: string }
interface Opened { role: string; can: string[]; members: { email: string; role: string }[]; invites?: { email: string; token?: string }[]; project: { id: string; name: string } }

const STAMP = Date.now().toString(36);
let roles: ThreeRoles;
let ownerOnInstance: string;
let ann: Member;
const projects: HubProject[] = [];
const people: Record<string, Member> = {};
const links: Record<string, { code: string; project: string }> = {};

const hubUrl = (path: string) => `${roles.hub.url}/api/hub${path}`;
const joinOf = (link: string): { code: string; project: string } => {
  const query = new URLSearchParams(new URL(link).hash.split('?')[1] ?? '');
  return { code: query.get('code')!, project: query.get('project')! };
};

async function repoThere(owner: string, name: string): Promise<boolean> {
  const answer = await fetch(`${roles.gitea!.url}/api/v1/repos/${owner}/${name}`, { headers: { Authorization: `Basic ${Buffer.from(`provisioning-bot:${roles.gitea!.adminPassword}`).toString('base64')}` } });
  return answer.status === 200;
}

async function toHub(person: Person): Promise<string> {
  const { exchange, location } = await handOff(fetchSide(roles.root.url, person.cookie), fetchSide(roles.hub.url), '/api/identity/go?to=hub&next=%2Fshared');
  const sent = new URL(location);
  expect(sent.origin).toBe(new URL(roles.hub.url).origin);
  expect(sent.searchParams.get('next') ?? new URLSearchParams(sent.hash.split('?')[1] ?? '').get('next')).toBe('/shared');
  const cookie = sessionFrom(exchange.setCookies);
  expect(signedInLanding(exchange) && cookie, `the hub did not sign the person in: ${exchange.status} ${exchange.body.slice(0, 300)}`).toBeTruthy();
  return cookie!;
}

beforeAll(async () => {
  roles = await startThreeRoles('hubpeople', { gitea: true, ownerInvited: true, rootWorkers: ['host'] });
  ownerOnInstance = await roles.ownerOnInstance();
  ann = { name: 'ann', person: roles.owner, hub: await roles.ownerOnHub() };
});

afterAll(async () => {
  await roles?.close();
});

describe('the hub\'s people: who is on a shared project, with which role, invited through root and removed', () => {
  beforeEach((context) => {
    context.onTestFailed(() => console.log(`── root ──\n${roles.root.logs(60)}\n── instance ──\n${roles.instance.logs(60)}\n── hub ──\n${roles.hub.logs(60)}\n── root's host worker ──\n${roles.workers['root-host']?.logs(60)}\n── gitea ──\n${roles.gitea?.logs()}`));
  });

  it('the owner makes two projects with repositories on their instance and shares both; the hub\'s repository holds each project\'s main, and the hub makes no project no instance shared', async () => {
    for (const name of [`Shop ${STAMP}`, `Other ${STAMP}`]) {
      const word = name.split(' ')[0]!.toLowerCase();
      const project = await call<{ id: string; giteaOwner: string; giteaRepo: string }>(`${roles.instance.url}/api/projects`, { method: 'POST', body: { name, giteaRepo: `${word}-${STAMP}`, createRepo: true }, cookie: ownerOnInstance });
      expect(project.status, JSON.stringify(project.body)).toBeLessThan(300);
      const before = await call<{ canShare: boolean; shared?: unknown }>(`${roles.instance.url}/api/project-sharing/${project.body.id}`, { cookie: ownerOnInstance });
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body.canShare).toBe(true);
      expect(before.body.shared, 'a project was on the hub before it was shared').toBeUndefined();
      const shared = await call<{ shared: { hubProjectId: string } }>(`${roles.instance.url}/api/project-sharing/${project.body.id}`, { method: 'POST', body: { group: `${word}${STAMP}` }, cookie: ownerOnInstance });
      expect(shared.status, JSON.stringify(shared.body)).toBe(200);
      const made = await call<Opened>(hubUrl(`/projects/${shared.body.shared.hubProjectId}`), { cookie: ann.hub });
      const auth = { username: 'provisioning-bot', token: roles.gitea!.adminPassword };
      const heads = await mainHeads(
        { url: `${roles.gitea!.url}/${project.body.giteaOwner}/${project.body.giteaRepo}.git`, auth },
        { url: `${roles.gitea!.url}/${hubOrgOf(shared.body.shared.hubProjectId)}/${HUB_REPO}.git`, auth },
      );
      expect(heads.owner, `the hub's repository does not hold the project's main: ${JSON.stringify(heads)}`).toBeTruthy();
      expect(heads.hub).toBe(heads.owner);
      expect([made.body.role, made.body.members.map((member) => member.email)]).toEqual(['owner', [ann.person.email]]);
      projects.push({ ...made.body.project, onInstance: project.body.id });
    }
    expect((await call(hubUrl('/projects'), { method: 'POST', body: { name: 'made on the hub' }, cookie: ann.hub })).status, 'the hub made a shared project that no instance shared').toBe(404);
  });

  it('the owner invites a collaborator and a client to Shop and someone else only to Other; the same address is not invited twice and no invite\'s token is shown', async () => {
    const [shop, other] = projects as [HubProject, HubProject];
    for (const [name, project, role] of [['bo', shop, 'collaborator'], ['cy', shop, 'client'], ['eve', other, 'client']] as const) {
      const email = `hub-people-${name}-${STAMP}@three.test`;
      const invited = await call<Invited>(hubUrl(`/projects/${project.id}/invites`), { method: 'POST', body: { email, role }, cookie: ann.hub });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      expect(invited.body.role).toBe(role);
      expect(String(invited.body.link)).toMatch(/^https?:\/\/[^/]+\/#\/join\?code=/);
      links[name] = joinOf(invited.body.link);
      people[name] = { name, person: { id: '', email, password: '', cookie: '' }, hub: '' };
    }
    expect((await call(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: people.bo!.person.email, role: 'client' }, cookie: ann.hub })).status, 'the same address was invited twice').toBe(400);
    const pending = (await call<Opened>(hubUrl(`/projects/${shop.id}`), { cookie: ann.hub })).body.invites!;
    expect(pending.map((entry) => entry.email).sort()).toEqual([people.bo!.person.email, people.cy!.person.email].sort());
    expect(pending.every((entry) => entry.token === undefined), 'the hub showed an invite\'s token').toBe(true);
  });

  it('root shows each invite to whoever holds its link, signed out, and lets only that address sign up with it', async () => {
    const shop = projects[0]!;
    const shown = await call(`${roles.root.url}/api/hub-link/invitation?code=${encodeURIComponent(links.cy!.code)}`);
    expect(shown.body).toEqual({ email: people.cy!.person.email, project: { name: shop.name, role: 'client', join: links.cy!.project }, used: false });
    const wrong = await call<{ error: string }>(`${roles.root.url}/api/auth/register`, { method: 'POST', body: { email: `hub-people-intruder-${STAMP}@three.test`, password: crypto.randomBytes(18).toString('base64url'), inviteCode: links.cy!.code } });
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(403);
    expect(wrong.body.error).toMatch(/This invite is for/);
    expect((await call<{ used: boolean }>(`${roles.root.url}/api/hub-link/invitation?code=${encodeURIComponent(links.cy!.code)}`)).body.used, 'a refused sign-up used the invite').toBe(false);
    expect((await call(`${roles.root.url}/api/hub-link/invite`, { method: 'POST', body: { email: 'x@example.com' } })).status, 'root took an invite from someone other than its hub').toBe(401);
    for (const name of ['bo', 'cy', 'eve']) {
      const member = people[name]!;
      member.person = await roles.signUp(member.person.email, links[name]!.code);
      member.hub = await toHub(member.person);
    }
    expect((await call<{ used: boolean }>(`${roles.root.url}/api/hub-link/invitation?code=${encodeURIComponent(links.cy!.code)}`)).body.used).toBe(true);
  });

  it('the outsider takes their own invite and reaches nothing of Shop, however they try', async () => {
    const [shop, other] = projects as [HubProject, HubProject];
    const eve = people.eve!;
    expect((await call(hubUrl(`/invitations/${links.eve!.project}/accept`), { method: 'POST', cookie: eve.hub })).status).toBe(200);
    expect((await call<{ project: { id: string } }[]>(hubUrl('/projects'), { cookie: eve.hub })).body.map((entry) => entry.project.id)).toEqual([other.id]);
    const tries = [
      await call(hubUrl(`/projects/${shop.id}`), { cookie: eve.hub }),
      await call(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: eve.person.email, role: 'owner' }, cookie: eve.hub }),
      await call(hubUrl(`/projects/${shop.id}/members/${eve.person.id}`), { method: 'PUT', body: { role: 'owner' }, cookie: eve.hub }),
      await call(hubUrl(`/projects/${shop.id}/members/${ann.person.id}`), { method: 'PUT', body: { role: 'client' }, cookie: eve.hub }),
      await call(hubUrl(`/projects/${shop.id}/members/${ann.person.id}`), { method: 'DELETE', cookie: eve.hub }),
      await call(hubUrl(`/projects/${shop.id}`), { method: 'DELETE', body: { name: shop.name }, cookie: eve.hub }),
      await call(hubUrl(`/projects/${crypto.randomBytes(12).toString('hex')}`), { cookie: eve.hub }),
      await call(hubUrl(`/projects/${encodeURIComponent('../koala_hub')}`), { cookie: eve.hub }),
    ];
    expect(tries.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
    const taken = await call(hubUrl(`/invitations/${links.bo!.project}/accept`), { method: 'POST', cookie: eve.hub });
    expect(taken.status, JSON.stringify(taken.body)).toBe(403);
    expect((await call(hubUrl(`/invitations/${crypto.randomBytes(24).toString('base64url')}/accept`), { method: 'POST', cookie: eve.hub })).status).toBe(404);
    expect((await call(hubUrl(`/projects/${shop.id}`))).status, 'the hub answered someone signed out').toBe(401);
  });

  it('the collaborator and the client join Shop, each with what their role lets them do', async () => {
    const shop = projects[0]!;
    const { bo, cy } = people as Record<'bo' | 'cy', Member>;
    const collaborator = await call<Opened>(hubUrl(`/invitations/${links.bo!.project}/accept`), { method: 'POST', cookie: bo.hub });
    expect(collaborator.status, JSON.stringify(collaborator.body)).toBe(200);
    expect(collaborator.body.can.includes('approve-changes') && collaborator.body.can.includes('change-files') && !collaborator.body.can.includes('invite')).toBe(true);
    const clientView = (await call<Opened>(hubUrl(`/invitations/${links.cy!.project}/accept`), { method: 'POST', cookie: cy.hub })).body;
    expect(clientView.can).toEqual(['see-project', 'see-people', 'pin-and-comment', 'ask-koala']);
    expect(clientView.invites, 'a client saw who is invited').toBeUndefined();
    expect(clientView.members.map((member) => `${member.email}:${member.role}`).sort()).toEqual([`${ann.person.email}:owner`, `${bo.person.email}:collaborator`, `${cy.person.email}:client`].sort());
    expect((await call(hubUrl(`/invitations/${links.cy!.project}/accept`), { method: 'POST', cookie: cy.hub })).status, 'an invite was taken twice').toBe(404);
    for (const [who, answer] of [
      [bo, await call(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: `x-${STAMP}@three.test`, role: 'owner' }, cookie: bo.hub })],
      [cy, await call(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: `x-${STAMP}@three.test`, role: 'owner' }, cookie: cy.hub })],
      [cy, await call(hubUrl(`/projects/${shop.id}/members/${cy.person.id}`), { method: 'PUT', body: { role: 'owner' }, cookie: cy.hub })],
      [bo, await call(hubUrl(`/projects/${shop.id}/members/${cy.person.id}`), { method: 'DELETE', cookie: bo.hub })],
      [bo, await call(hubUrl(`/projects/${shop.id}`), { method: 'DELETE', body: { name: shop.name }, cookie: bo.hub })],
    ] as const) expect(answer.status, `${who.name} was let do what only an owner may: ${JSON.stringify(answer.body)}`).toBe(403);
  });

  it('the owner changes a role, takes an invite back, and removes someone; the client leaves; the last owner cannot', async () => {
    const shop = projects[0]!;
    const { bo, cy } = people as Record<'bo' | 'cy', Member>;
    const promoted = await call(hubUrl(`/projects/${shop.id}/members/${cy.person.id}`), { method: 'PUT', body: { role: 'collaborator' }, cookie: ann.hub });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect((await call<Opened>(hubUrl(`/projects/${shop.id}`), { cookie: cy.hub })).body.can).toContain('change-files');
    expect((await call(hubUrl(`/projects/${shop.id}/members/${cy.person.id}`), { method: 'PUT', body: { role: 'client' }, cookie: ann.hub })).status).toBe(200);
    const dee = `hub-people-dee-${STAMP}@three.test`;
    const invited = await call<Invited>(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: dee, role: 'client' }, cookie: ann.hub });
    expect((await call(hubUrl(`/projects/${shop.id}/invites?email=${encodeURIComponent(dee)}`), { method: 'DELETE', cookie: ann.hub })).status).toBe(200);
    expect((await call(hubUrl(`/invitations/${joinOf(invited.body.link).project}`), { cookie: ann.hub })).status, 'an invite taken back still opened').toBe(404);
    expect((await call(hubUrl(`/projects/${shop.id}/members/${bo.person.id}`), { method: 'DELETE', cookie: ann.hub })).status).toBe(200);
    expect((await call(hubUrl(`/projects/${shop.id}`), { cookie: bo.hub })).status, 'someone removed still saw the project').toBe(404);
    expect((await call(hubUrl(`/projects/${shop.id}/members/${cy.person.id}`), { method: 'DELETE', cookie: cy.hub })).status).toBe(200);
    expect((await call(hubUrl('/projects'), { cookie: cy.hub })).body).toEqual([]);
    const lastOwner = await call(hubUrl(`/projects/${shop.id}/members/${ann.person.id}`), { method: 'DELETE', cookie: ann.hub });
    expect(lastOwner.status, JSON.stringify(lastOwner.body)).toBe(400);
  });

  it('an admin caps how many new people the owner\'s invites may bring: someone new is refused, someone with an account is not, and the default comes back', async () => {
    const shop = projects[0]!;
    const admin = roles.operator.cookie;
    const limits = await call<{ people: { id: string; made: number }[] }>(`${roles.root.url}/api/admin/project-invites`, { cookie: admin });
    expect(limits.status, JSON.stringify(limits.body)).toBe(200);
    const made = limits.body.people.find((person) => person.id === ann.person.id)?.made;
    expect(made !== undefined && made >= 3, `the owner's invites made ${made} accounts, and at least three were sent`).toBe(true);
    expect((await call(`${roles.root.url}/api/admin/people/${ann.person.id}/project-invites`, { method: 'PUT', body: { accounts: made }, cookie: admin })).status).toBe(200);
    const newcomer = `hub-people-new-${STAMP}@three.test`;
    const refused = await call<{ error: string }>(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: newcomer, role: 'client' }, cookie: ann.hub });
    expect(refused.status, JSON.stringify(refused.body)).toBe(429);
    expect(String(refused.body.error)).toMatch(new RegExp(`as many as you may \\(${made}\\)`));
    expect((await call<Opened>(hubUrl(`/projects/${shop.id}`), { cookie: ann.hub })).body.invites!.some((invite) => invite.email === newcomer), 'a refused invite was kept').toBe(false);
    const known = await call(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: people.bo!.person.email, role: 'client' }, cookie: ann.hub });
    expect(known.status, `inviting someone with an account was refused: ${JSON.stringify(known.body)}`).toBeLessThan(300);
    expect((await call(hubUrl(`/projects/${shop.id}/invites?email=${encodeURIComponent(people.bo!.person.email)}`), { method: 'DELETE', cookie: ann.hub })).status).toBe(200);
    expect((await call(`${roles.root.url}/api/admin/people/${ann.person.id}/project-invites`, { method: 'PUT', body: { accounts: null }, cookie: admin })).status).toBe(200);
    const allowed = await call(hubUrl(`/projects/${shop.id}/invites`), { method: 'POST', body: { email: newcomer, role: 'client' }, cookie: ann.hub });
    expect(allowed.status, `with the default back, the invite was refused: ${JSON.stringify(allowed.body)}`).toBeLessThan(300);
    expect((await call(hubUrl(`/projects/${shop.id}/invites?email=${encodeURIComponent(newcomer)}`), { method: 'DELETE', cookie: ann.hub })).status).toBe(200);
  });

  it('the owner cannot remove their account while they alone own a project someone else is on; the outsider removes theirs and is taken off it', async () => {
    const [shop, other] = projects as [HubProject, HubProject];
    const preview = (await call<{ blockers: string[] }>(`${roles.root.url}/api/account/removal`, { cookie: ann.person.cookie })).body;
    expect(preview.blockers.some((line) => line.includes(`"${other.name}"`)), JSON.stringify(preview)).toBe(true);
    expect(preview.blockers.some((line) => line.includes(`"${shop.name}"`)), 'a project only the owner is on blocked the removal').toBe(false);
    const refused = await call(`${roles.root.url}/api/account`, { method: 'DELETE', body: { confirm: ann.person.email, password: ann.person.password }, cookie: ann.person.cookie });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((await call(hubUrl(`/projects/${shop.id}`), { cookie: ann.hub })).status, 'a refused removal still let the owner go').toBe(200);
    await removeAccountOnRoot(roles, people.eve!.person);
    expect((await call<Opened>(hubUrl(`/projects/${other.id}`), { cookie: ann.hub })).body.members.map((member) => member.email)).toEqual([ann.person.email]);
  });

  it('the owner deletes one project by its name; removing their account deletes the one only they are on; nothing of either is left on the hub', async () => {
    const other = projects[1]!;
    expect((await call(hubUrl(`/projects/${other.id}`), { method: 'DELETE', body: { name: 'not its name' }, cookie: ann.hub })).status).toBe(400);
    expect((await call(hubUrl(`/projects/${other.id}`), { method: 'DELETE', body: { name: other.name }, cookie: ann.hub })).status).toBe(200);
    await until('the instance to stop showing the deleted project as shared', async () => {
      const read = await call<{ shared?: unknown }>(`${roles.instance.url}/api/project-sharing/${other.onInstance}`, { cookie: ownerOnInstance });
      return read.body.shared === undefined ? true : waiting(`the instance answers ${read.status} with shared ${JSON.stringify(read.body.shared).slice(0, 150)}`);
    });
    expect((await call<{ blockers: string[] }>(`${roles.root.url}/api/account/removal`, { cookie: ann.person.cookie })).body.blockers).toEqual([]);
    await removeAccountOnRoot(roles, ann.person);
    const { client, release } = await leaseMongo(roles.mongoUri);
    try {
      const databases = (await client.db().admin().listDatabases()).databases.map((entry) => entry.name);
      for (const project of projects) expect(databases, `${HUB_DATABASE_PREFIX}${project.id} is still there`).not.toContain(`${HUB_DATABASE_PREFIX}${project.id}`);
      for (const project of projects) expect(await repoThere(hubOrgOf(project.id), HUB_REPO), `${hubOrgOf(project.id)}/${HUB_REPO} is still in Gitea`).toBe(false);
      const registry = client.db(roles.databases.hub);
      const ids = projects.map((project) => project.id);
      expect(await registry.collection('shared_projects').countDocuments({ _id: { $in: ids as never[] } })).toBe(0);
      expect(await registry.collection('shared_memberships').countDocuments({ projectId: { $in: ids } })).toBe(0);
      expect(await registry.collection('shared_invites').countDocuments({ projectId: { $in: ids } })).toBe(0);
    } finally {
      await release();
    }
  });
});
