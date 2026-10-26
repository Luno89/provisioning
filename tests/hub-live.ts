import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { MongoClient } from 'mongodb';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { mongoTarget } from '../apps/backend/src/platform/lib/mongo-db.js';
import { signJWT } from '../apps/backend/src/platform/lib/auth.js';
import { loadKeys } from '../apps/backend/src/platform/lib/keys.js';
import { HUB_DATABASE_PREFIX } from '../apps/backend/src/hub/lib/hub.js';
import { HUB_REPO, hubOrgOf } from '../apps/backend/src/hub/services/HubRepos.js';
import { mainHeads } from '../apps/backend/src/hub/services/HubRepoSync.js';
import { GiteaService } from '../apps/backend/src/projects/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';

const ROOT = process.env.HUB_LIVE_ROOT ?? 'http://localhost:3001';
const HUB = process.env.HUB_LIVE_HUB ?? ROOT;
const HUB_DATABASE = process.env.HUB_DATABASE?.trim() || 'koala_hub';
const ADMIN = process.env.MECHANICS_ADMIN ?? process.env.GROVE_LIVE_OWNER;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let stageCount = 0;
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  stageCount += 1;
  const started = Date.now();
  console.log(`[${stageCount}] ${name}`);
  try {
    const value = await run();
    console.log(`    ok (${Math.round((Date.now() - started) / 1000)}s)`);
    return value;
  } catch (err) {
    console.log(`    FAILED at "${name}": ${(err as Error).message}`);
    throw err;
  }
}

const client = (base: string, cookie?: string): AxiosInstance => axios.create({ baseURL: `${base}/api`, proxy: false, maxRedirects: 0, headers: cookie ? { Cookie: cookie } : {}, validateStatus: () => true });
const sessionOf = (headers: Record<string, unknown>): string | undefined => ([] as string[]).concat((headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session=') && pair !== 'session=');

interface Person { name: string; email: string; password: string; id?: string; root?: AxiosInstance; hub?: AxiosInstance; removed?: boolean }

const stamp = Date.now().toString(36);
const person = (name: string): Person => ({ name, email: `hub-live-${name}-${stamp}@nowrinkles.test`, password: crypto.randomBytes(18).toString('base64url') });

async function signUp(who: Person, code: string): Promise<void> {
  const registered = await client(ROOT).post('/auth/register', { email: who.email, password: who.password, inviteCode: code });
  assert.equal(registered.status, 200, `${who.name} could not sign up: ${JSON.stringify(registered.data)}`);
  const login = await client(ROOT).post('/auth/login', { email: who.email, password: who.password });
  const cookie = sessionOf(login.headers);
  assert.ok(login.status === 200 && cookie, `${who.name} could not sign in: ${JSON.stringify(login.data)}`);
  who.root = client(ROOT, cookie);
  who.id = (await who.root.get('/auth/me')).data.id as string;
  who.hub = HUB === ROOT ? who.root : await toHub(who.root);
}

async function toHub(atRoot: AxiosInstance): Promise<AxiosInstance> {
  const go = await atRoot.get('/identity/go', { params: { to: 'hub', next: '/shared' } });
  assert.equal(go.status, 302, JSON.stringify(go.data));
  const sent = new URL(String(go.headers.location));
  assert.equal(sent.origin, new URL(HUB).origin);
  const query = new URLSearchParams(sent.hash.split('?')[1] ?? '');
  assert.equal(query.get('next'), '/shared');
  const handoff = await client(HUB).post('/auth/handoff', { token: query.get('token') });
  const cookie = sessionOf(handoff.headers);
  assert.ok(handoff.status === 200 && cookie, `the hub did not take root's token: ${JSON.stringify(handoff.data)}`);
  return client(HUB, cookie);
}

const joinOf = (link: string): { code: string; project: string } => {
  const query = new URLSearchParams(new URL(link).hash.split('?')[1] ?? '');
  return { code: query.get('code')!, project: query.get('project')! };
};

async function main(): Promise<void> {
  assert.ok(ADMIN, 'set MECHANICS_ADMIN (or GROVE_LIVE_OWNER) to an admin, who invites this test\'s first account');
  const db = createDatabase();
  await db.init();
  const admin = await db.accounts.getUserById(ADMIN);
  assert.ok(admin?.isAdmin, `${ADMIN} is not an admin`);
  const adminHttp = client(ROOT, `session=${signJWT({ userId: admin.id, email: admin.email }, loadKeys(process.env).session, 3600)}`);
  const mongo = await MongoClient.connect(mongoTarget(process.env).uri);
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, '/tmp/kubeconfig-provisioning-lunorica');

  const removeAccount = async (who: Person): Promise<void> => {
    const removed = await who.root!.delete('/account', { data: { confirm: who.email } });
    assert.equal(removed.status, 202, `${who.name}'s removal answered ${removed.status}: ${JSON.stringify(removed.data)}`);
    who.removed = true;
    for (let tries = 0; tries < 150 && await db.accounts.getUserById(who.id!); tries += 1) await sleep(2_000);
    assert.equal(await db.accounts.getUserById(who.id!), undefined, `${who.email} was not removed`);
  };

  const ann = person('ann');
  const bo = person('bo');
  const cy = person('cy');
  const eve = person('eve');
  const everyone = [ann, bo, cy, eve];
  const projects: { id: string; name: string; onInstance: string }[] = [];

  try {
    await stage('an owner signs up with an admin\'s invite and makes two shared projects', async () => {
      const invite = (await adminHttp.post('/admin/invites')).data as { code: string };
      await signUp(ann, invite.code);
      for (const name of [`Shop ${stamp}`, `Other ${stamp}`]) {
        const project = await ann.root!.post('/projects', { name, giteaRepo: `${name.split(' ')[0]!.toLowerCase()}-${stamp}`, createRepo: true });
        assert.ok(project.status < 300, JSON.stringify(project.data));
        const before = await ann.root!.get(`/project-sharing/${project.data.id}`);
        assert.equal(before.status, 200, JSON.stringify(before.data));
        assert.equal(before.data.canShare, true);
        assert.equal(before.data.shared, undefined, 'a project was on the hub before it was shared');
        const shared = await ann.root!.post(`/project-sharing/${project.data.id}`, { group: `${name.split(' ')[0]!.toLowerCase()}${stamp}` });
        assert.equal(shared.status, 200, JSON.stringify(shared.data));
        const made = await ann.hub!.get(`/hub/projects/${shared.data.shared.hubProjectId}`);
        const admin = await gitea.getAdminCredentials();
        const auth = { username: admin.username, token: admin.password };
        const heads = await mainHeads(
          { url: await gitea.repoGitUrl(project.data.giteaOwner, project.data.giteaRepo), auth },
          { url: await gitea.repoGitUrl(hubOrgOf(shared.data.shared.hubProjectId), HUB_REPO), auth },
        );
        assert.ok(heads.owner && heads.owner === heads.hub, `the hub's repository does not hold the project's main: ${JSON.stringify(heads)}`);
        assert.deepEqual([made.data.role, made.data.members.map((m: { email: string }) => m.email)], ['owner', [ann.email]]);
        projects.push({ ...made.data.project, onInstance: project.data.id });
      }
      assert.equal((await ann.hub!.post('/hub/projects', { name: 'made on the hub' })).status, 404, 'the hub made a shared project that no instance shared');
    });
    const [shop, other] = projects as [typeof projects[number], typeof projects[number]];

    const links = await stage('the owner invites a collaborator and a client to Shop, and someone else only to Other', async () => {
      const sent: Record<string, { code: string; project: string }> = {};
      for (const [who, project, role] of [[bo, shop, 'collaborator'], [cy, shop, 'client'], [eve, other, 'client']] as const) {
        const invited = await ann.hub!.post(`/hub/projects/${project.id}/invites`, { email: who.email, role });
        assert.equal(invited.status, 201, JSON.stringify(invited.data));
        assert.equal(invited.data.role, role);
        assert.match(String(invited.data.link), /^https?:\/\/[^/]+\/#\/join\?code=/, invited.data.link);
        console.log(`    ${who.name}: ${invited.data.emailed ? 'emailed' : `not emailed (${invited.data.why}), link returned`}`);
        sent[who.name] = joinOf(invited.data.link);
      }
      assert.equal((await ann.hub!.post(`/hub/projects/${shop.id}/invites`, { email: bo.email, role: 'client' })).status, 400, 'the same address was invited twice');
      const pending = (await ann.hub!.get(`/hub/projects/${shop.id}`)).data.invites as { email: string; token?: string }[];
      assert.deepEqual(pending.map((entry) => entry.email).sort(), [bo.email, cy.email].sort());
      assert.ok(pending.every((entry) => entry.token === undefined), 'the hub showed an invite\'s token');
      return sent;
    });

    await stage('root shows each invite to whoever holds its link, signed out, and lets only that address sign up with it', async () => {
      const shown = await client(ROOT).get('/hub-link/invitation', { params: { code: links.cy!.code } });
      assert.deepEqual(shown.data, { email: cy.email, project: { name: shop.name, role: 'client', join: links.cy!.project }, used: false });
      const wrong = await client(ROOT).post('/auth/register', { email: `hub-live-intruder-${stamp}@nowrinkles.test`, password: 'x'.repeat(16), inviteCode: links.cy!.code });
      assert.equal(wrong.status, 403, JSON.stringify(wrong.data));
      assert.match(wrong.data.error, /This invite is for/);
      assert.equal((await client(ROOT).get('/hub-link/invitation', { params: { code: links.cy!.code } })).data.used, false, 'a refused sign-up used the invite');
      assert.equal((await client(ROOT).post('/hub-link/invite', { email: 'x@example.com' })).status, 401, 'root took an invite from someone other than its hub');
      for (const who of [bo, cy, eve]) await signUp(who, links[who.name]!.code);
      assert.equal((await client(ROOT).get('/hub-link/invitation', { params: { code: links.cy!.code } })).data.used, true);
    });

    await stage('the outsider takes their own invite and reaches nothing of Shop, however they try', async () => {
      assert.equal((await eve.hub!.post(`/hub/invitations/${links.eve!.project}/accept`)).status, 200);
      assert.deepEqual((await eve.hub!.get('/hub/projects')).data.map((entry: { project: { id: string } }) => entry.project.id), [other.id]);
      const tries = [
        await eve.hub!.get(`/hub/projects/${shop.id}`),
        await eve.hub!.post(`/hub/projects/${shop.id}/invites`, { email: eve.email, role: 'owner' }),
        await eve.hub!.put(`/hub/projects/${shop.id}/members/${eve.id}`, { role: 'owner' }),
        await eve.hub!.put(`/hub/projects/${shop.id}/members/${ann.id}`, { role: 'client' }),
        await eve.hub!.delete(`/hub/projects/${shop.id}/members/${ann.id}`),
        await eve.hub!.delete(`/hub/projects/${shop.id}`, { data: { name: shop.name } }),
        await eve.hub!.get(`/hub/projects/${crypto.randomBytes(12).toString('hex')}`),
        await eve.hub!.get(`/hub/projects/${encodeURIComponent('../koala_hub')}`),
      ];
      assert.deepEqual(tries.map((answer) => answer.status), [404, 404, 404, 404, 404, 404, 404, 404]);
      const taken = await eve.hub!.post(`/hub/invitations/${links.bo!.project}/accept`);
      assert.equal(taken.status, 403, JSON.stringify(taken.data));
      assert.equal((await eve.hub!.post(`/hub/invitations/${crypto.randomBytes(24).toString('base64url')}/accept`)).status, 404);
      assert.equal((await client(HUB).get(`/hub/projects/${shop.id}`)).status, 401, 'the hub answered someone signed out');
    });

    await stage('the collaborator and the client join Shop, each with what their role lets them do', async () => {
      const collaborator = await bo.hub!.post(`/hub/invitations/${links.bo!.project}/accept`);
      assert.equal(collaborator.status, 200, JSON.stringify(collaborator.data));
      assert.ok(collaborator.data.can.includes('approve-changes') && collaborator.data.can.includes('change-files') && !collaborator.data.can.includes('invite'));
      const clientView = (await cy.hub!.post(`/hub/invitations/${links.cy!.project}/accept`)).data;
      assert.deepEqual(clientView.can, ['see-project', 'see-people', 'pin-and-comment', 'ask-koala']);
      assert.equal(clientView.invites, undefined, 'a client saw who is invited');
      assert.deepEqual(clientView.members.map((m: { email: string; role: string }) => `${m.email}:${m.role}`).sort(), [`${ann.email}:owner`, `${bo.email}:collaborator`, `${cy.email}:client`].sort());
      assert.equal((await cy.hub!.post(`/hub/invitations/${links.cy!.project}/accept`)).status, 404, 'an invite was taken twice');
      for (const [who, answer] of [
        [bo, await bo.hub!.post(`/hub/projects/${shop.id}/invites`, { email: `x-${stamp}@nowrinkles.test`, role: 'owner' })],
        [cy, await cy.hub!.post(`/hub/projects/${shop.id}/invites`, { email: `x-${stamp}@nowrinkles.test`, role: 'owner' })],
        [cy, await cy.hub!.put(`/hub/projects/${shop.id}/members/${cy.id}`, { role: 'owner' })],
        [bo, await bo.hub!.delete(`/hub/projects/${shop.id}/members/${cy.id}`)],
        [bo, await bo.hub!.delete(`/hub/projects/${shop.id}`, { data: { name: shop.name } })],
      ] as const) assert.equal(answer.status, 403, `${who.name} was let do what only an owner may: ${JSON.stringify(answer.data)}`);
    });

    await stage('the owner changes a role, takes an invite back, and removes someone; the client leaves; the last owner cannot', async () => {
      const promoted = await ann.hub!.put(`/hub/projects/${shop.id}/members/${cy.id}`, { role: 'collaborator' });
      assert.equal(promoted.status, 200, JSON.stringify(promoted.data));
      assert.ok((await cy.hub!.get(`/hub/projects/${shop.id}`)).data.can.includes('change-files'));
      await ann.hub!.put(`/hub/projects/${shop.id}/members/${cy.id}`, { role: 'client' });
      const dee = `hub-live-dee-${stamp}@nowrinkles.test`;
      const invited = await ann.hub!.post(`/hub/projects/${shop.id}/invites`, { email: dee, role: 'client' });
      assert.equal((await ann.hub!.delete(`/hub/projects/${shop.id}/invites`, { params: { email: dee } })).status, 200);
      assert.equal((await ann.hub!.get(`/hub/invitations/${joinOf(invited.data.link).project}`)).status, 404, 'an invite taken back still opened');
      assert.equal((await ann.hub!.delete(`/hub/projects/${shop.id}/members/${bo.id}`)).status, 200);
      assert.equal((await bo.hub!.get(`/hub/projects/${shop.id}`)).status, 404, 'someone removed still saw the project');
      assert.equal((await cy.hub!.delete(`/hub/projects/${shop.id}/members/${cy.id}`)).status, 200);
      assert.deepEqual((await cy.hub!.get('/hub/projects')).data, []);
      const lastOwner = await ann.hub!.delete(`/hub/projects/${shop.id}/members/${ann.id}`);
      assert.equal(lastOwner.status, 400, JSON.stringify(lastOwner.data));
    });

    await stage('the owner cannot remove their account while they alone own a project someone else is on; the outsider removes theirs and is taken off it', async () => {
      const preview = (await ann.root!.get('/account/removal')).data as { blockers: string[] };
      assert.ok(preview.blockers.some((line) => line.includes(`"${other.name}"`)), JSON.stringify(preview));
      assert.ok(!preview.blockers.some((line) => line.includes(`"${shop.name}"`)), 'a project only the owner is on blocked the removal');
      const refused = await ann.root!.delete('/account', { data: { confirm: ann.email } });
      assert.equal(refused.status, 409, JSON.stringify(refused.data));
      assert.equal((await ann.hub!.get(`/hub/projects/${shop.id}`)).status, 200, 'a refused removal still let the owner go');
      await removeAccount(eve);
      assert.deepEqual(((await ann.hub!.get(`/hub/projects/${other.id}`)).data.members as { email: string }[]).map((member) => member.email), [ann.email]);
    });

    await stage('the owner deletes one project by its name; removing their account deletes the one only they are on; nothing of either is left on the hub', async () => {
      assert.equal((await ann.hub!.delete(`/hub/projects/${other.id}`, { data: { name: 'not its name' } })).status, 400);
      assert.equal((await ann.hub!.delete(`/hub/projects/${other.id}`, { data: { name: other.name } })).status, 200);
      for (let tries = 0; tries < 30 && (await ann.root!.get(`/project-sharing/${other.onInstance}`)).data.shared; tries += 1) await sleep(1_000);
      assert.equal((await ann.root!.get(`/project-sharing/${other.onInstance}`)).data.shared, undefined, 'the instance still took Other as shared after it was deleted on the hub');
      assert.deepEqual((await ann.root!.get('/account/removal')).data.blockers, []);
      await removeAccount(ann);
      const databases = (await mongo.db().admin().listDatabases()).databases.map((entry) => entry.name);
      for (const project of projects) assert.ok(!databases.includes(`${HUB_DATABASE_PREFIX}${project.id}`), `${HUB_DATABASE_PREFIX}${project.id} is still there`);
      for (const project of projects) assert.equal(await gitea.findRepo(hubOrgOf(project.id), HUB_REPO), null, `${hubOrgOf(project.id)}/${HUB_REPO} is still in Gitea`);
      const registry = mongo.db(HUB_DATABASE);
      const ids = projects.map((project) => project.id);
      assert.equal(await registry.collection('shared_projects').countDocuments({ _id: { $in: ids as never[] } }), 0);
      assert.equal(await registry.collection('shared_memberships').countDocuments({ projectId: { $in: ids } }), 0);
      assert.equal(await registry.collection('shared_invites').countDocuments({ projectId: { $in: ids } }), 0);
      projects.length = 0;
    });
  } finally {
    for (const project of projects) await ann.hub?.delete(`/hub/projects/${project.id}`, { data: { name: project.name } }).catch(() => undefined);
    for (const who of everyone.filter((entry) => entry.root && !entry.removed)) await removeAccount(who).catch((err: Error) => console.log(`    could not remove ${who.email}: ${err.message}`));
    console.log(`    removed ${everyone.filter((entry) => entry.id).length} test accounts`);
    await mongo.close();
    await db.close?.();
  }
  console.log('\nhub live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
