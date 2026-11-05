import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startModelStandIn, type ModelStandIn } from '../models/testing/model-stand-in.js';
import { call, startThreeRoles, until, type Person, type ThreeRoles } from '../platform/testing/three-roles.js';

interface Member { name: 'client' | 'collaborator'; person: Person; hub: string }
interface Grant { runId: string; personId: string; state: string; revokedBecause?: string; principal?: { claims?: { role: string; project?: string; as?: string }[] } }

const STAMP = Date.now().toString(36);
const PROJECT = `split-shop-${STAMP}`;
const GROUP = `sp${STAMP}`.slice(0, 20);
let roles: ThreeRoles;
let model: ModelStandIn;
let mongo: MongoClient;
let atInstance: string;
let ownerHub: string;
let machineId: string;
let projectId: string;
let hubProjectId: string;
let channel: string;
let clientGrant: Grant;
const members: Member[] = [];

const onInstance = (path: string) => `${roles.instance.url}/api${path}`;
const onHub = (path: string) => `${roles.hub.url}/api/hub${path}`;
const instanceDb = () => mongo.db(roles.databases.instance);
const grants = async (): Promise<Grant[]> => instanceDb().collection('runGrants').find({}).toArray() as unknown as Promise<Grant[]>;

beforeAll(async () => {
  model = await startModelStandIn('Noted.', { holding: true });
  roles = await startThreeRoles('members', { gitea: true, instanceWorkers: ['engine'] });
  mongo = new MongoClient(roles.mongoUri);
  await mongo.connect();
}, 300_000);

afterAll(async () => {
  await mongo?.close();
  await roles?.close();
  await model?.close();
}, 120_000);

describe('a project shared from its owner\'s instance and worked on the hub by its members', () => {
  beforeEach((context) => {
    context.onTestFailed(() => console.log(`── root ──\n${roles.root.logs(40)}\n── instance ──\n${roles.instance.logs(80)}\n── instance's engine worker ──\n${roles.workers['instance-engine']?.logs(80)}\n── hub ──\n${roles.hub.logs(60)}\n── model asked ──\n${model.asked.length} times, ${model.waiting()} waiting`));
  });

  it('the owner signs in on their instance and on the hub, both through root, and makes a model of their own the default', async () => {
    atInstance = await roles.ownerOnInstance();
    ownerHub = await roles.ownerOnHub();
    const connected = await call(onInstance('/credentials/llm'), { method: 'POST', body: { provider: 'custom', baseUrl: model.baseUrl, model: model.model }, cookie: atInstance });
    expect(connected.status, JSON.stringify(connected.body)).toBe(200);
    const listed = await call<{ id: string }[]>(onInstance('/models'), { cookie: atInstance });
    expect(listed.body, JSON.stringify(listed.body)).toHaveLength(1);
    expect((await call(onInstance('/models/default'), { method: 'PUT', body: { modelId: listed.body[0]!.id }, cookie: atInstance })).status).toBe(200);
  });

  it('a machine of the owner\'s joins the account at root with the command the instance gives, and the instance takes it from root, so a project can run there without a repository', async () => {
    const code = await call<{ command: string; code: string }>(onInstance('/mesh/local-agents/join-code'), { method: 'POST', body: {}, cookie: atInstance });
    expect(code.status, JSON.stringify(code.body)).toBe(201);
    expect(code.body.command.startsWith(`curl -fsSL ${roles.root.url}/machine.sh`), `the command does not join at root: ${code.body.command}`).toBe(true);
    const joined = await call(`${roles.root.url}/api/machines/join`, { method: 'POST', body: { code: code.body.code, hostname: `split-${STAMP}`, rootDir: '/home/koala/work', os: 'linux' } });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const machine = await until(async () => {
      const machines = (await call<{ id: string; name: string }[]>(onInstance('/mesh/local-agents'), { cookie: atInstance })).body;
      return Array.isArray(machines) ? machines.find((entry) => entry.name === `split-${STAMP}`) : undefined;
    });
    machineId = machine.id;
  });

  it('the owner makes a project and shares it to the hub under a group, the instance calling the hub with a service token', async () => {
    const made = await call<{ id: string }>(onInstance('/projects'), { method: 'POST', body: { name: PROJECT, executionTargetDeviceId: machineId, executionTargetPath: '/home/koala/work/shop' }, cookie: atInstance });
    expect(made.status === 200 || made.status === 201, `the project was not made: ${made.status} ${JSON.stringify(made.body)}`).toBe(true);
    projectId = made.body.id;
    const shared = await call(onInstance(`/project-sharing/${projectId}`), { method: 'POST', body: { group: GROUP }, cookie: atInstance });
    expect(shared.status, `sharing was refused: ${JSON.stringify(shared.body)}`).toBe(200);
    const onTheHub = await until(async () => {
      const listed = (await call<{ project: { id: string; name: string; group?: string } }[]>(onHub('/projects'), { cookie: ownerHub })).body;
      return Array.isArray(listed) ? listed.find((entry) => entry.project.name === PROJECT)?.project : undefined;
    });
    expect(onTheHub.group).toBe(GROUP);
    hubProjectId = onTheHub.id;
  });

  it('the owner invites a client and a collaborator; root emails each an invite bound to their address, and each signs up on root with the emailed code and joins through root\'s sign-in', async () => {
    for (const name of ['client', 'collaborator'] as const) {
      const email = `${name}-${STAMP}@three.test`;
      const invited = await call<{ link: string }>(onHub(`/projects/${hubProjectId}/invites`), { method: 'POST', body: { email, role: name }, cookie: ownerHub });
      expect(invited.status === 200 || invited.status === 201, `${name}'s invite was refused: ${invited.status} ${JSON.stringify(invited.body)}`).toBe(true);
      const link = new URL(String(invited.body.link).replace('/#/', '/'));
      const inviteCode = link.searchParams.get('code')!;
      const joinToken = link.searchParams.get('project')!;
      expect(inviteCode && joinToken, `the invite link carries no code: ${invited.body.link}`).toBeTruthy();
      expect(roles.mail.received.some((message) => message.to.includes(email) && message.data.includes(inviteCode)), `root did not email ${name} the invite`).toBe(true);
      const person = await roles.signUp(email, inviteCode);
      const hub = await roles.onHub(person.cookie, `/hub/join/${joinToken}`);
      const accepted = await call(onHub(`/invitations/${joinToken}/accept`), { method: 'POST', body: {}, cookie: hub });
      expect(accepted.status, `${name} could not join: ${JSON.stringify(accepted.body)}`).toBe(200);
      members.push({ name, person, hub });
    }
    const people = (await call(onHub(`/projects/${hubProjectId}`), { cookie: ownerHub })).body;
    for (const member of members) expect(JSON.stringify(people), `${member.name} is not among the project's people`).toContain(member.person.id);
  });

  it('the client asks Koala in the project\'s channel; the owner\'s instance starts the turn as the client, on the client\'s role, and its engine worker takes it', async () => {
    const clientMember = members[0]!;
    const opened = await call<{ channel: { id: string } }>(onInstance(`/projects/${projectId}/channel`), { cookie: atInstance });
    expect(opened.status, `the project's channel could not be opened: ${JSON.stringify(opened.body)}`).toBeLessThan(300);
    channel = opened.body.channel.id;
    await until(async () => {
      const read = (await call<{ chats?: { id: string }[] }>(onHub(`/projects/${hubProjectId}/board`), { cookie: clientMember.hub })).body;
      return read.chats?.some((chat) => chat.id === channel) ? true : undefined;
    });
    const asked = await call<{ asked?: { id: string } }>(onHub(`/projects/${hubProjectId}/conversations/${channel}/messages`), { method: 'POST', body: { content: 'Koala, store a note called client.txt', askKoala: true }, cookie: clientMember.hub });
    expect(asked.status, `the client's message was refused: ${asked.status} ${JSON.stringify(asked.body)}`).toBeLessThan(300);
    expect(asked.body.asked?.id, 'the client\'s message asked Koala nothing').toBeTruthy();
    clientGrant = await until(async () => (await grants()).find((grant) => grant.personId === clientMember.person.id));
    const role = clientGrant.principal?.claims?.find((claim) => claim.role === 'shared');
    expect(role?.as, `the turn does not carry the client's role: ${JSON.stringify(clientGrant.principal)}`).toBe('client');
    await until(async () => ((await instanceDb().collection('turnLogs').findOne({ turnId: clientGrant.runId })) ? true : undefined));
    await until(async () => (model.waiting() > 0 ? true : undefined));
  });

  it('the collaborator posts, and is not asked about; the owner removes the client on the hub, the client\'s run on the instance loses its grant, and the hub\'s channel says the run was ended', async () => {
    const [clientMember, collaboratorMember] = members as [Member, Member];
    expect((await call(onHub(`/projects/${hubProjectId}/conversations/${channel}/messages`), { method: 'POST', body: { content: 'noted' }, cookie: collaboratorMember.hub })).status).toBeLessThan(300);
    const removed = await call(onHub(`/projects/${hubProjectId}/members/${clientMember.person.id}`), { method: 'DELETE', cookie: ownerHub });
    expect(removed.status, `the client could not be removed: ${JSON.stringify(removed.body)}`).toBe(200);
    const revoked = await until(async () => {
      const grant = (await grants()).find((entry) => entry.runId === clientGrant.runId);
      return grant?.state === 'revoked' ? grant : undefined;
    });
    expect(revoked.revokedBecause).toBe('removed-from-shared-project');
    expect((await call(onHub(`/projects/${hubProjectId}/board`), { cookie: clientMember.hub })).status, 'the removed client still reads the project').toBe(404);
    model.release();
    const told = await until(async () => {
      const read = (await call<{ messages?: { role: string; content: string }[] }>(onHub(`/projects/${hubProjectId}/conversations/${channel}`), { cookie: collaboratorMember.hub })).body;
      return read.messages?.find((message) => message.role === 'notice' && /removed from the shared project/.test(message.content));
    });
    expect(told.content).toMatch(/This run was ended because/);
  });

  it('the owner takes the project back by its name; the hub\'s copy is gone', async () => {
    const collaboratorMember = members[1]!;
    const back = await call(onInstance(`/project-sharing/${projectId}`), { method: 'DELETE', body: { confirm: PROJECT }, cookie: atInstance });
    expect(back.status, `taking it back was refused: ${JSON.stringify(back.body)}`).toBe(200);
    await until(async () => ((await call(onHub(`/projects/${hubProjectId}`), { cookie: ownerHub })).status === 404 ? true : undefined));
    expect((await call(onHub(`/projects/${hubProjectId}/board`), { cookie: collaboratorMember.hub })).status, 'the collaborator still reads a project taken back').toBe(404);
  });
}, 300_000);
