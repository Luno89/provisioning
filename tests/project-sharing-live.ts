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
import { GiteaService } from '../apps/backend/src/projects/services/GiteaService.js';
import { InfrastructureService } from '../apps/backend/src/infrastructure/services/InfrastructureService.js';

const BASE = process.env.SHARING_LIVE_URL ?? 'http://localhost:3001';
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

async function until<T>(what: string, probe: () => Promise<T | undefined>, tries = 60): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const found = await probe();
    if (found !== undefined) return found;
    await sleep(1_000);
  }
  throw new Error(`${what} did not happen`);
}

const client = (cookie?: string): AxiosInstance => axios.create({ baseURL: `${BASE}/api`, proxy: false, headers: cookie ? { Cookie: cookie } : {}, validateStatus: () => true });
const sessionOf = (headers: Record<string, unknown>): string | undefined => ([] as string[]).concat((headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session=') && pair !== 'session=');

async function main(): Promise<void> {
  assert.ok(ADMIN, 'set MECHANICS_ADMIN (or GROVE_LIVE_OWNER) to an admin, who invites this test\'s account');
  const db = createDatabase();
  await db.init();
  const admin = await db.accounts.getUserById(ADMIN);
  assert.ok(admin?.isAdmin, `${ADMIN} is not an admin`);
  const adminHttp = client(`session=${signJWT({ userId: admin.id, email: admin.email }, loadKeys(process.env).session, 3600)}`);
  const mongo = await MongoClient.connect(mongoTarget(process.env).uri);
  const gitea = new GiteaService(new InfrastructureService(), loadKeys(process.env).data, '/tmp/kubeconfig-provisioning-lunorica');
  const stamp = Date.now().toString(36);
  const email = `sharing-live-${stamp}@nowrinkles.test`;
  const password = crypto.randomBytes(18).toString('base64url');
  let owner: AxiosInstance | undefined;
  let ownerId: string | undefined;
  let member: AxiosInstance | undefined;
  let memberId: string | undefined;
  const memberEmail = `sharing-live-client-${stamp}@nowrinkles.test`;

  try {
    const project = await stage('an owner signs up and has a project with a repository and a channel someone has talked in', async () => {
      const invite = (await adminHttp.post('/admin/invites')).data as { code: string };
      assert.equal((await client().post('/auth/register', { email, password, inviteCode: invite.code })).status, 200);
      const login = await client().post('/auth/login', { email, password });
      owner = client(sessionOf(login.headers));
      ownerId = (await owner.get('/auth/me')).data.id as string;
      const made = await owner.post('/projects', { name: `Shared ${stamp}`, giteaRepo: `shared-${stamp}`, createRepo: true });
      assert.ok(made.status < 300, JSON.stringify(made.data));
      const channel = await owner.get(`/projects/${made.data.id}/channel`);
      assert.equal(channel.status, 200, JSON.stringify(channel.data));
      const channelId = channel.data.channel.id as string;
      assert.equal((await owner.post(`/conversations/${channelId}/messages`, { content: 'said before sharing' })).status < 300, true);
      return { id: made.data.id as string, name: made.data.name as string, giteaOwner: made.data.giteaOwner as string, giteaRepo: made.data.giteaRepo as string, channelId };
    });

    const hubId = await stage('the preview says what goes and what stays; nothing is on the hub until it is shared', async () => {
      const preview = (await owner!.get(`/project-sharing/${project.id}`)).data;
      assert.equal(preview.shared, undefined);
      assert.equal(preview.moves.chats, 1);
      assert.equal(preview.moves.repository, project.giteaRepo);
      assert.ok(preview.stays.length > 0);
      assert.deepEqual((await owner!.get('/hub/projects')).data, []);
      const shared = await owner!.post(`/project-sharing/${project.id}`);
      assert.equal(shared.status, 200, JSON.stringify(shared.data));
      return shared.data.shared.hubProjectId as string;
    });
    const onHub = mongo.db(`${HUB_DATABASE_PREFIX}${hubId}`);
    const hubChannel = () => onHub.collection('board_conversations').findOne({ _id: project.channelId as never });
    const said = async () => ((await hubChannel())?.messages as { content: string }[] | undefined ?? []).map((message) => message.content);

    await stage('the channel goes to the hub with what was said in it, and what is said afterwards follows', async () => {
      assert.deepEqual(await said(), ['said before sharing']);
      assert.ok((await owner!.post(`/conversations/${project.channelId}/messages`, { content: 'said after sharing' })).status < 300);
      await until('the new message reaching the hub', async () => ((await said()).includes('said after sharing') ? true : undefined));
    });

    await stage('the owner reads the hub\'s board: the channel is there and the owner\'s instance is online', async () => {
      const board = await until('the board showing the channel and the instance online', async () => {
        const read = await owner!.get(`/hub/projects/${hubId}/board`);
        assert.equal(read.status, 200, JSON.stringify(read.data));
        const has = (read.data.chats as { id: string; kind?: string }[]).some((chat) => chat.id === project.channelId && chat.kind === 'channel');
        return has && read.data.online === true ? read.data : undefined;
      }, 15);
      assert.equal(board.role, 'owner');
      assert.ok(board.can.includes('approve-changes'));
    });

    await stage('a client is invited, signs up with the invite, accepts, and sees the board without what only workers need', async () => {
      const sent = await owner!.post(`/hub/projects/${hubId}/invites`, { email: memberEmail, role: 'client' });
      assert.equal(sent.status < 300, true, JSON.stringify(sent.data));
      const link = new URL((sent.data.link as string).replace('/#/', '/'));
      const code = link.searchParams.get('code');
      const token = link.searchParams.get('project');
      assert.ok(code && token, sent.data.link);
      assert.equal((await client().post('/auth/register', { email: memberEmail, password, inviteCode: code })).status, 200);
      const login = await client().post('/auth/login', { email: memberEmail, password });
      member = client(sessionOf(login.headers));
      memberId = (await member.get('/auth/me')).data.id as string;
      const accepted = await member.post(`/hub/invitations/${encodeURIComponent(token)}/accept`);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      const board = await member.get(`/hub/projects/${hubId}/board`);
      assert.equal(board.status, 200, JSON.stringify(board.data));
      assert.equal(board.data.role, 'client');
      assert.equal(board.data.online, true);
      assert.ok(!board.data.can.includes('approve-changes'));
      assert.ok((board.data.chats as { kind?: string }[]).some((chat) => chat.kind === 'channel'));
      for (const leaf of board.data.board.leaves as Record<string, unknown>[]) {
        assert.equal('claim' in leaf, false);
        assert.equal('runId' in leaf, false);
      }
      const refused = await member.post(`/hub/projects/${hubId}/requests`, { kind: 'accept-task', taskId: 'nothing' });
      assert.equal(refused.status, 403, JSON.stringify(refused.data));
    });

    await stage('the client posts in the channel without asking Koala, and the owner reads it with their name; the client may not read the code but the files relay answers', async () => {
      const posted = await member!.post(`/hub/projects/${hubId}/conversations/${project.channelId}/messages`, { content: 'from the client', askKoala: false });
      assert.equal(posted.status < 300, true, JSON.stringify(posted.data));
      assert.equal(posted.data.asked, undefined);
      const seen = await until('the client\'s message in the owner\'s channel', async () => {
        const read = await owner!.get(`/conversations/${project.channelId}`);
        const messages = ((read.data.conversation ?? read.data).messages ?? []) as { content: string; authorName?: string }[];
        return messages.find((message) => message.content === 'from the client');
      }, 30);
      assert.equal(seen.authorName, memberEmail);
      assert.equal((await member!.get(`/hub/projects/${hubId}/repository`)).status, 403);
      const files = await member!.get(`/hub/projects/${hubId}/files/list`, { params: { dir: '' } });
      assert.ok(files.status === 200 || (files.status === 409 && String(files.data.error).includes('no file server')), `the files relay answered ${files.status} ${JSON.stringify(files.data)}`);
      console.log(`    files relay answered through the owner's instance: ${files.status} ${files.data.error ?? 'with the listing'}`);
    });

    await stage('the owner\'s main reaches the hub, and work pushed to the hub\'s main reaches the owner', async () => {
      await gitea.putFile(project.giteaOwner, project.giteaRepo, 'from-owner.txt', 'the owner wrote this\n', 'From the owner', 'main');
      await until('the owner\'s commit on the hub', async () => ((await gitea.getRawFile(hubOrgOf(hubId), HUB_REPO, 'from-owner.txt', 'main')) === 'the owner wrote this\n' ? true : undefined));
      await gitea.putFile(hubOrgOf(hubId), HUB_REPO, 'from-member.txt', 'a member wrote this\n', 'From a member', 'main');
      await until('the member\'s commit on the owner\'s repository', async () => ((await gitea.getRawFile(project.giteaOwner, project.giteaRepo, 'from-member.txt', 'main')) === 'a member wrote this\n' ? true : undefined));
    });

    await stage('taking it back needs its name, then leaves everything on the instance and nothing on the hub', async () => {
      assert.equal((await owner!.delete(`/project-sharing/${project.id}`, { data: { confirm: 'not its name' } })).status, 400);
      const back = await owner!.delete(`/project-sharing/${project.id}`, { data: { confirm: project.name } });
      assert.equal(back.status, 200, JSON.stringify(back.data));
      assert.equal(back.data.shared, undefined);
      const databases = (await mongo.db().admin().listDatabases()).databases.map((entry) => entry.name);
      assert.ok(!databases.includes(`${HUB_DATABASE_PREFIX}${hubId}`), 'the hub kept its copy');
      assert.equal(await gitea.findRepo(hubOrgOf(hubId), HUB_REPO), null, 'the hub kept its repository');
      assert.deepEqual((await owner!.get('/hub/projects')).data, []);
      assert.equal(await gitea.getRawFile(project.giteaOwner, project.giteaRepo, 'from-member.txt', 'main'), 'a member wrote this\n');
      const channel = await owner!.get(`/conversations/${project.channelId}`);
      assert.equal(channel.status, 200, JSON.stringify(channel.data));
      const contents = (((channel.data.conversation ?? channel.data).messages ?? []) as { content: string }[]).map((message) => message.content);
      assert.ok(contents.includes('said before sharing') && contents.includes('said after sharing'), JSON.stringify(contents));
      assert.equal((await db.hub.getHubLinks()).filter((link) => link.projectId === project.id).length, 0);
    });
  } finally {
    if (member && memberId) {
      const removed = await member.delete('/account', { data: { confirm: memberEmail } });
      if (removed.status !== 202) console.log(`    could not remove ${memberEmail}: ${removed.status} ${JSON.stringify(removed.data)}`);
      for (let tries = 0; tries < 150 && await db.accounts.getUserById(memberId); tries += 1) await sleep(2_000);
      assert.equal(await db.accounts.getUserById(memberId), undefined, `${memberEmail} was not removed`);
      console.log('    removed the client account');
    }
    if (owner && ownerId) {
      const removed = await owner.delete('/account', { data: { confirm: email } });
      if (removed.status !== 202) console.log(`    could not remove ${email}: ${removed.status} ${JSON.stringify(removed.data)}`);
      for (let tries = 0; tries < 150 && await db.accounts.getUserById(ownerId); tries += 1) await sleep(2_000);
      assert.equal(await db.accounts.getUserById(ownerId), undefined, `${email} was not removed`);
      console.log('    removed the test account');
    }
    await mongo.close();
    await db.close?.();
  }
  console.log('\nproject sharing live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
