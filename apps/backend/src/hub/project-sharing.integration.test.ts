import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { mock } from 'vitest-mock-extended';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InfrastructureService } from '../infrastructure/index.js';
import { createDatabase } from '../platform/lib/db-interface.js';
import { call, startThreeRoles, until, type Person, type ThreeRoles } from '../platform/testing/three-roles.js';
import { GiteaService } from '../projects/services/GiteaService.js';
import { HUB_DATABASE_PREFIX } from './lib/hub.js';
import { HUB_REPO, hubOrgOf } from './services/HubRepos.js';

interface Project { id: string; name: string; giteaOwner: string; giteaRepo: string; channelId: string }
interface Preview { shared?: { hubProjectId: string }; group?: string; addresses: { scope: string }; moves: { chats: number; repository?: string }; stays: string[] }
interface Board { role: string; can: string[]; online: boolean; chats: { id: string; kind?: string }[]; board: unknown }
interface Message { content: string; authorName?: string }

const STAMP = Date.now().toString(36);
const GROUP = `sl${STAMP}`.slice(0, 20);
let roles: ThreeRoles;
let gitea: GiteaService;
let dataDir: string;
let savedGiteaUrl: string | undefined;
let owner: string;
let ownerHub: string;
let project: Project;
let second: { id: string; name: string };
let hubId: string;
let member: Person;
let memberHub: string;
const memberEmail = `sharing-client-${STAMP}@three.test`;

const onInstance = (path: string) => `${roles.instance.url}/api${path}`;
const onHub = (path: string) => `${roles.hub.url}/api/hub${path}`;

async function withMongo<T>(work: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(roles.mongoUri);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

const said = async (): Promise<string[]> => withMongo(async (client) => {
  const channel = await client.db(`${HUB_DATABASE_PREFIX}${hubId}`).collection('board_conversations').findOne({ _id: project.channelId as never });
  return ((channel?.messages as Message[] | undefined) ?? []).map((message) => message.content);
});

async function accountGone(id: string): Promise<boolean> {
  const db = createDatabase({ ...process.env, MONGO_URI: `${roles.mongoUri}${roles.databases.root}` });
  await db.init();
  try {
    return (await db.accounts.getUserById(id)) === undefined;
  } finally {
    await db.close?.();
  }
}

beforeAll(async () => {
  roles = await startThreeRoles('sharing', { gitea: true, ownerInvited: true, rootWorkers: ['host'] });
  owner = await roles.ownerOnInstance();
  ownerHub = await roles.ownerOnHub();
  savedGiteaUrl = process.env.GITEA_URL;
  process.env.GITEA_URL = roles.gitea!.url;
  dataDir = await mkdtemp(path.join(tmpdir(), 'sharing-gitea-'));
  await writeFile(path.join(dataDir, '.gitea-admin-password'), roles.gitea!.adminPassword);
  const infra = mock<Pick<InfrastructureService, 'runKubectl' | 'getK3dServerIp'>>();
  infra.runKubectl.mockRejectedValue(new Error('the integration tier reaches no cluster'));
  gitea = new GiteaService(infra, 'sharing-test-key' as never, '/nowhere', { dataDir });
}, 300_000);

afterAll(async () => {
  if (savedGiteaUrl === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = savedGiteaUrl;
  await roles?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 120_000);

describe('sharing a project from its owner\'s instance to the hub, and taking it back', () => {
  beforeEach((context) => {
    context.onTestFailed(() => console.log(`── root ──\n${roles.root.logs(40)}\n── instance ──\n${roles.instance.logs(80)}\n── hub ──\n${roles.hub.logs(60)}\n── root's host worker ──\n${roles.workers['root-host']?.logs(40)}\n── gitea ──\n${roles.gitea?.logs()}`));
  });

  it('the owner has a project with a repository and a channel someone has talked in', async () => {
    const made = await call<{ id: string; name: string; giteaOwner: string; giteaRepo: string }>(onInstance('/projects'), { method: 'POST', body: { name: `Shared ${STAMP}`, giteaRepo: `shared-${STAMP}`, createRepo: true }, cookie: owner });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const channel = await call<{ channel: { id: string } }>(onInstance(`/projects/${made.body.id}/channel`), { cookie: owner });
    expect(channel.status, JSON.stringify(channel.body)).toBe(200);
    expect((await call(onInstance(`/conversations/${channel.body.channel.id}/messages`), { method: 'POST', body: { content: 'said before sharing' }, cookie: owner })).status).toBeLessThan(300);
    project = { id: made.body.id, name: made.body.name, giteaOwner: made.body.giteaOwner, giteaRepo: made.body.giteaRepo, channelId: channel.body.channel.id };
  });

  it('the group check refuses a dashed name and a reserved one and suggests one from the project\'s name; sharing without a group is refused', async () => {
    const ask = async (name: string) => {
      const answer = await call<{ ok: boolean; problem?: string; suggested: string; example?: string }>(onInstance(`/project-sharing/${project.id}/group-check?name=${encodeURIComponent(name)}`), { cookie: owner });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body;
    };
    const suggested = await ask('');
    expect(suggested.ok).toBe(false);
    expect(suggested.suggested).toBe(`shared${STAMP}`.slice(0, 20));
    const dashed = await ask('sl-dash');
    expect(dashed.ok).toBe(false);
    expect(dashed.problem ?? '').toMatch(/no dashes/);
    const reserved = await ask('mail');
    expect(reserved.ok).toBe(false);
    expect(reserved.problem ?? '').toMatch(/kept for the platform/);
    const fine = await ask(GROUP);
    expect(fine.ok, JSON.stringify(fine)).toBe(true);
    expect(fine.example).toBeUndefined();
    const without = await call(onInstance(`/project-sharing/${project.id}`), { method: 'POST', body: {}, cookie: owner });
    expect(without.status, JSON.stringify(without.body)).toBe(400);
    const dashedShare = await call(onInstance(`/project-sharing/${project.id}`), { method: 'POST', body: { group: 'sl-dash' }, cookie: owner });
    expect(dashedShare.status, JSON.stringify(dashedShare.body)).toBe(400);
    expect((await call(onHub('/projects'), { cookie: ownerHub })).body).toEqual([]);
  });

  it('the preview says what goes and what stays; nothing is on the hub until it is shared under its group', async () => {
    const preview = (await call<Preview>(onInstance(`/project-sharing/${project.id}`), { cookie: owner })).body;
    expect(preview.shared).toBeUndefined();
    expect(preview.group).toBeUndefined();
    expect(preview.addresses.scope).toBe('owner');
    expect(preview.moves.chats).toBe(1);
    expect(preview.moves.repository).toBe(project.giteaRepo);
    expect(preview.stays.length).toBeGreaterThan(0);
    expect((await call(onHub('/projects'), { cookie: ownerHub })).body).toEqual([]);
    const shared = await call<Preview & { shared: { hubProjectId: string } }>(onInstance(`/project-sharing/${project.id}`), { method: 'POST', body: { group: GROUP }, cookie: owner });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.group).toBe(GROUP);
    expect(shared.body.addresses.scope).toBe('group');
    expect((await call<Preview>(onInstance(`/project-sharing/${project.id}`), { cookie: owner })).body.group).toBe(GROUP);
    const onTheHub = await call<{ project: { group?: string } }>(onHub(`/projects/${shared.body.shared.hubProjectId}`), { cookie: ownerHub });
    expect(onTheHub.status, JSON.stringify(onTheHub.body)).toBe(200);
    expect(onTheHub.body.project.group, 'the hub\'s project does not carry the group').toBe(GROUP);
    hubId = shared.body.shared.hubProjectId;
  });

  it('a second project cannot be shared under the group the first holds', async () => {
    const made = await call<{ id: string; name: string }>(onInstance('/projects'), { method: 'POST', body: { name: `Second ${STAMP}`, giteaRepo: `second-${STAMP}`, createRepo: true }, cookie: owner });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const check = await call<{ ok: boolean; problem?: string }>(onInstance(`/project-sharing/${made.body.id}/group-check?name=${GROUP}`), { cookie: owner });
    expect(check.body.ok, JSON.stringify(check.body)).toBe(false);
    expect(check.body.problem ?? '').toMatch(/is taken/);
    const refused = await call(onInstance(`/project-sharing/${made.body.id}`), { method: 'POST', body: { group: GROUP }, cookie: owner });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    second = { id: made.body.id, name: made.body.name };
  });

  it('the channel goes to the hub with what was said in it, and what is said afterwards follows', async () => {
    expect(await said()).toEqual(['said before sharing']);
    expect((await call(onInstance(`/conversations/${project.channelId}/messages`), { method: 'POST', body: { content: 'said after sharing' }, cookie: owner })).status).toBeLessThan(300);
    await until(async () => ((await said()).includes('said after sharing') ? true : undefined));
  });

  it('the owner reads the hub\'s board: the channel is there and the owner\'s instance is online; the owner who shared it cannot leave it on the hub', async () => {
    const board = await until(async () => {
      const read = await call<Board>(onHub(`/projects/${hubId}/board`), { cookie: ownerHub });
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      const has = read.body.chats.some((chat) => chat.id === project.channelId && chat.kind === 'channel');
      return has && read.body.online === true ? read.body : undefined;
    });
    expect(board.role).toBe('owner');
    expect(board.can).toContain('approve-changes');
    const leaving = await call<{ error: string }>(onHub(`/projects/${hubId}/members/${roles.owner.id}`), { method: 'DELETE', cookie: ownerHub });
    expect(leaving.status, JSON.stringify(leaving.body)).toBe(400);
    expect(String(leaving.body.error)).toMatch(/shared this project from your instance; take it back there/);
  });

  it('a client is invited, signs up with the invite, accepts, and sees the whole board the owner sees', async () => {
    const sent = await call<{ link: string }>(onHub(`/projects/${hubId}/invites`), { method: 'POST', body: { email: memberEmail, role: 'client' }, cookie: ownerHub });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const link = new URL(sent.body.link.replace('/#/', '/'));
    const code = link.searchParams.get('code');
    const token = link.searchParams.get('project');
    expect(code && token, sent.body.link).toBeTruthy();
    member = await roles.signUp(memberEmail, code!);
    memberHub = await roles.onHub(member.cookie);
    const accepted = await call(onHub(`/invitations/${encodeURIComponent(token!)}/accept`), { method: 'POST', cookie: memberHub });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const board = await call<Board>(onHub(`/projects/${hubId}/board`), { cookie: memberHub });
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect(board.body.role).toBe('client');
    expect(board.body.online).toBe(true);
    expect(board.body.can).not.toContain('approve-changes');
    expect(board.body.chats.some((chat) => chat.kind === 'channel')).toBe(true);
    expect(board.body.can).not.toContain('change-files');
    await until(async () => {
      const [theirs, owners] = await Promise.all([call<Board>(onHub(`/projects/${hubId}/board`), { cookie: memberHub }), call<Board>(onHub(`/projects/${hubId}/board`), { cookie: ownerHub })]);
      return JSON.stringify(theirs.body.board) === JSON.stringify(owners.body.board) ? true : undefined;
    });
    const refused = await call(onHub(`/projects/${hubId}/requests`), { method: 'POST', body: { kind: 'accept-task', taskId: 'nothing' }, cookie: memberHub });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  });

  it('the client posts in the channel without asking Koala, and the owner reads it with their name; the client reads the code and the files, and may not move or remove one', async () => {
    const posted = await call<{ asked?: unknown }>(onHub(`/projects/${hubId}/conversations/${project.channelId}/messages`), { method: 'POST', body: { content: 'from the client', askKoala: false }, cookie: memberHub });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    expect(posted.body.asked).toBeUndefined();
    const seen = await until(async () => {
      const read = await call<{ conversation?: { messages?: Message[] }; messages?: Message[] }>(onInstance(`/conversations/${project.channelId}`), { cookie: owner });
      return ((read.body.conversation ?? read.body).messages ?? []).find((message) => message.content === 'from the client');
    });
    expect(seen.authorName).toBe(memberEmail);
    const code = await call<{ files: string[] }>(onHub(`/projects/${hubId}/repository`), { cookie: memberHub });
    expect(code.status, JSON.stringify(code.body)).toBe(200);
    expect(Array.isArray(code.body.files), JSON.stringify(code.body)).toBe(true);
    const moved = await call(onHub(`/projects/${hubId}/files/move`), { method: 'POST', body: { from: 'anything.txt', to: 'elsewhere.txt' }, cookie: memberHub });
    expect(moved.status, JSON.stringify(moved.body)).toBe(403);
    const removed = await call(onHub(`/projects/${hubId}/files/content?path=anything.txt`), { method: 'DELETE', cookie: memberHub });
    expect(removed.status, JSON.stringify(removed.body)).toBe(403);
    const files = await call<{ error?: string }>(onHub(`/projects/${hubId}/files/list?dir=`), { cookie: memberHub });
    expect(files.status === 200 || (files.status === 409 && String(files.body.error).includes('no file server')), `the files relay answered ${files.status} ${JSON.stringify(files.body)}`).toBe(true);
  });

  it('the owner\'s main reaches the hub, and work pushed to the hub\'s main reaches the owner', async () => {
    await gitea.putFile(project.giteaOwner, project.giteaRepo, 'from-owner.txt', 'the owner wrote this\n', 'From the owner', 'main');
    await until(async () => ((await gitea.getRawFile(hubOrgOf(hubId), HUB_REPO, 'from-owner.txt', 'main')) === 'the owner wrote this\n' ? true : undefined));
    await gitea.putFile(hubOrgOf(hubId), HUB_REPO, 'from-member.txt', 'a member wrote this\n', 'From a member', 'main');
    await until(async () => ((await gitea.getRawFile(project.giteaOwner, project.giteaRepo, 'from-member.txt', 'main')) === 'a member wrote this\n' ? true : undefined));
  });

  it('taking it back needs its name, then leaves everything on the instance and nothing on the hub', async () => {
    expect((await call(onInstance(`/project-sharing/${project.id}`), { method: 'DELETE', body: { confirm: 'not its name' }, cookie: owner })).status).toBe(400);
    const back = await call<Preview>(onInstance(`/project-sharing/${project.id}`), { method: 'DELETE', body: { confirm: project.name }, cookie: owner });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.shared).toBeUndefined();
    const databases = await withMongo(async (client) => (await client.db().admin().listDatabases()).databases.map((entry) => entry.name));
    expect(databases, 'the hub kept its copy').not.toContain(`${HUB_DATABASE_PREFIX}${hubId}`);
    expect(await gitea.findRepo(hubOrgOf(hubId), HUB_REPO), 'the hub kept its repository').toBeNull();
    expect((await call(onHub('/projects'), { cookie: ownerHub })).body).toEqual([]);
    expect(await gitea.getRawFile(project.giteaOwner, project.giteaRepo, 'from-member.txt', 'main')).toBe('a member wrote this\n');
    const channel = await call<{ conversation?: { messages?: Message[] }; messages?: Message[] }>(onInstance(`/conversations/${project.channelId}`), { cookie: owner });
    expect(channel.status, JSON.stringify(channel.body)).toBe(200);
    const contents = ((channel.body.conversation ?? channel.body).messages ?? []).map((message) => message.content);
    expect(contents.includes('said before sharing') && contents.includes('said after sharing'), JSON.stringify(contents)).toBe(true);
    const instanceDb = createDatabase({ ...process.env, MONGO_URI: `${roles.mongoUri}${roles.databases.instance}` });
    await instanceDb.init();
    try {
      expect((await instanceDb.hub.getHubLinks()).filter((link) => link.projectId === project.id)).toHaveLength(0);
    } finally {
      await instanceDb.close?.();
    }
    expect(back.body.group).toBeUndefined();
    expect(back.body.addresses.scope).toBe('owner');
  });

  it('the group is free once the first project is taken back: the second is shared under it, then taken back too', async () => {
    const shared = await call<Preview>(onInstance(`/project-sharing/${second.id}`), { method: 'POST', body: { group: GROUP }, cookie: owner });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.group).toBe(GROUP);
    const back = await call<Preview>(onInstance(`/project-sharing/${second.id}`), { method: 'DELETE', body: { confirm: second.name }, cookie: owner });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.shared).toBeUndefined();
  });

  it('the client and then the owner remove their accounts on root', async () => {
    for (const who of [member, roles.owner]) {
      const removed = await call(`${roles.root.url}/api/account`, { method: 'DELETE', body: { confirm: who.email, password: who.password }, cookie: who.cookie });
      expect(removed.status, JSON.stringify(removed.body)).toBe(202);
      await until(async () => ((await accountGone(who.id)) ? true : undefined));
    }
  });
}, 300_000);
