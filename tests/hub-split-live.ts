import assert from 'node:assert/strict';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './lib/handoff.js';
import { sessionCookieOf, signUp } from './lib/sign-up.js';
import { call, ownerOnInstance, startSplitStack, type SplitStack } from './lib/split-stack.js';

const step = (message: string) => console.log(`\n▶ ${message}`);

async function eventually<T>(what: string, probe: () => Promise<T | undefined>, tries = 240): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`${what} did not happen within ${tries / 2} s`);
}

const json = (cookie: string, method: string, body?: unknown): RequestInit & { cookie: string } =>
  ({ method, cookie, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

interface Member { name: 'client' | 'collaborator'; email: string; id: string; hub: string }
interface Grant { runId: string; personId: string; state: string; revokedBecause?: string; principal?: { claims?: { role: string; project?: string; as?: string }[] } }

async function hubSession(stack: SplitStack, rootCookie: string, next?: string): Promise<string> {
  const handed = await handOff(fetchSide(stack.rootUrl, rootCookie), fetchSide(stack.hubUrl), `/api/identity/go?to=hub${next ? `&next=${encodeURIComponent(next)}` : ''}`);
  const session = sessionFrom(handed.exchange.setCookies);
  assert.ok(signedInLanding(handed.exchange) && session, `the hub did not sign them in: ${handed.exchange.status} ${handed.exchange.body.slice(0, 300)}`);
  return session;
}

async function grants(stack: SplitStack): Promise<Grant[]> {
  const { db, close } = await stack.instanceDb();
  try {
    return await db.collection('runGrants').find({}).toArray() as unknown as Grant[];
  } finally {
    await close();
  }
}

async function turnLogged(stack: SplitStack, runId: string): Promise<boolean> {
  const { db, close } = await stack.instanceDb();
  try {
    return Boolean(await db.collection('turnLogs').findOne({ turnId: runId }));
  } finally {
    await close();
  }
}

async function stages(stack: SplitStack): Promise<void> {
  const { rootUrl, instanceUrl, hubUrl, owner, names } = stack;

  step('the owner signs in on their instance and on the hub, both through root');
  const atInstance = await ownerOnInstance(stack);
  const ownerHub = await hubSession(stack, owner.cookie);

  step('a machine of the owner\'s joins the instance, so a project can run there without a repository');
  const code = await call(`${instanceUrl}/api/mesh/local-agents/join-code`, json(atInstance, 'POST', {}));
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const joined = await call(`${instanceUrl}/api/machines/join`, { method: 'POST', body: JSON.stringify({ code: (code.body as { code: string }).code, hostname: `split-${names.stamp}`, rootDir: '/home/koala/work', os: 'linux' }) });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const machines = (await call(`${instanceUrl}/api/mesh/local-agents`, { cookie: atInstance })).body as { id: string; name: string }[];
  const machine = machines.find((entry) => entry.name === `split-${names.stamp}`);
  assert.ok(machine, `the joined machine is not listed: ${JSON.stringify(machines)}`);

  step('the owner makes a project and shares it to the hub under a group, the instance calling the hub with a service token');
  const projectName = `split-shop-${names.stamp}`;
  const made = await call(`${instanceUrl}/api/projects`, json(atInstance, 'POST', { name: projectName, executionTargetDeviceId: machine.id, executionTargetPath: '/home/koala/work/shop' }));
  assert.ok(made.status === 200 || made.status === 201, `the project was not made: ${made.status} ${JSON.stringify(made.body)}`);
  const projectId = (made.body as { id: string }).id;
  const group = `sp${names.stamp}`.slice(0, 20);
  const shared = await call(`${instanceUrl}/api/project-sharing/${projectId}`, json(atInstance, 'POST', { group }));
  assert.equal(shared.status, 200, `sharing was refused: ${JSON.stringify(shared.body)}`);
  const onHub = await eventually('the shared project on the hub', async () => {
    const listed = (await call(`${hubUrl}/api/hub/projects`, { cookie: ownerHub })).body as { project: { id: string; name: string; group?: string } }[];
    return Array.isArray(listed) ? listed.find((entry) => entry.project.name === projectName)?.project : undefined;
  });
  assert.equal(onHub.group, group);
  console.log(`  shared as ${onHub.id} under ${group}`);

  step('the owner invites a client and a collaborator; root emails each an invite bound to their address');
  const members: Member[] = [];
  for (const name of ['client', 'collaborator'] as const) {
    const email = `${name}-${names.stamp}@split.test`;
    const invited = await call(`${hubUrl}/api/hub/projects/${onHub.id}/invites`, json(ownerHub, 'POST', { email, role: name }));
    assert.ok(invited.status === 200 || invited.status === 201, `${name}'s invite was refused: ${invited.status} ${JSON.stringify(invited.body)}`);
    const link = new URL(String((invited.body as { link: string }).link).replace('/#/', '/'));
    const inviteCode = link.searchParams.get('code')!;
    const joinToken = link.searchParams.get('project')!;
    assert.ok(inviteCode && joinToken, `the invite link carries no code: ${String((invited.body as { link: string }).link)}`);
    const signedUp = await signUp(`${rootUrl}/api`, { email, password: `pw-${names.stamp}-${name}-long`, inviteCode }, { mailpitApi: stack.mailpitApi });
    const rootCookie = sessionCookieOf(signedUp);
    assert.ok(rootCookie && signedUp.user, `${name} could not sign up on root: ${signedUp.status} ${signedUp.error ?? ''}`);
    const hub = await hubSession(stack, rootCookie, `/hub/join/${joinToken}`);
    const accepted = await call(`${hubUrl}/api/hub/invitations/${joinToken}/accept`, json(hub, 'POST', {}));
    assert.equal(accepted.status, 200, `${name} could not join: ${JSON.stringify(accepted.body)}`);
    members.push({ name, email, id: signedUp.user.id, hub });
    console.log(`  ${name} signed up on root with the emailed code and joined through root's sign-in`);
  }
  const [clientMember, collaboratorMember] = members as [Member, Member];
  const people = (await call(`${hubUrl}/api/hub/projects/${onHub.id}`, { cookie: ownerHub })).body as { members?: { personId?: string; id?: string; role: string }[] };
  for (const member of members) assert.ok(JSON.stringify(people).includes(member.id), `${member.name} is not among the project's people`);

  step('the client asks Koala in the project\'s channel; the owner\'s instance starts the turn as the client, on the client\'s role');
  const opened = await call(`${instanceUrl}/api/projects/${projectId}/channel`, { cookie: atInstance });
  assert.ok(opened.status < 300, `the project's channel could not be opened: ${JSON.stringify(opened.body)}`);
  const channel = (opened.body as { channel: { id: string } }).channel.id;
  await eventually('the channel reaching the hub\'s board', async () => {
    const read = (await call(`${hubUrl}/api/hub/projects/${onHub.id}/board`, { cookie: clientMember.hub })).body as { chats?: { id: string }[] };
    return read.chats?.some((chat) => chat.id === channel) ? true : undefined;
  });
  const asked = await call(`${hubUrl}/api/hub/projects/${onHub.id}/conversations/${channel}/messages`, json(clientMember.hub, 'POST', { content: 'Koala, store a note called client.txt', askKoala: true }));
  assert.ok(asked.status < 300, `the client's message was refused: ${asked.status} ${JSON.stringify(asked.body)}`);
  assert.ok((asked.body as { asked?: { id: string } }).asked?.id, 'the client\'s message asked Koala nothing');
  const clientGrant = await eventually('the owner\'s instance starting the client\'s turn', async () =>
    (await grants(stack)).find((grant) => grant.personId === clientMember.id));
  const role = clientGrant.principal?.claims?.find((claim) => claim.role === 'shared');
  assert.equal(role?.as, 'client', `the turn does not carry the client's role: ${JSON.stringify(clientGrant.principal)}`);
  await eventually('the instance\'s engine worker running the client\'s turn', async () => (await turnLogged(stack, clientGrant.runId)) || undefined);
  console.log(`  run ${clientGrant.runId} runs as the client (${role?.as}) on the owner's instance, and its engine worker took it`);

  step('the collaborator posts, and is not asked about; the owner removes the client on the hub, and the client\'s run on the instance loses its grant');
  assert.ok((await call(`${hubUrl}/api/hub/projects/${onHub.id}/conversations/${channel}/messages`, json(collaboratorMember.hub, 'POST', { content: 'noted' }))).status < 300);
  const removed = await call(`${hubUrl}/api/hub/projects/${onHub.id}/members/${clientMember.id}`, json(ownerHub, 'DELETE'));
  assert.equal(removed.status, 200, `the client could not be removed: ${JSON.stringify(removed.body)}`);
  const revoked = await eventually('the client\'s grant being revoked on the owner\'s instance', async () => {
    const grant = (await grants(stack)).find((entry) => entry.runId === clientGrant.runId);
    return grant?.state === 'revoked' ? grant : undefined;
  });
  assert.equal(revoked.revokedBecause, 'removed-from-shared-project');
  assert.equal((await call(`${hubUrl}/api/hub/projects/${onHub.id}/board`, { cookie: clientMember.hub })).status, 404, 'the removed client still reads the project');
  const told = await eventually('the channel on the hub hearing the run was ended', async () => {
    const read = (await call(`${hubUrl}/api/hub/projects/${onHub.id}/conversations/${channel}`, { cookie: collaboratorMember.hub })).body as { messages?: { role: string; content: string }[] };
    return read.messages?.find((message) => message.role === 'notice' && /removed from the shared project/.test(message.content));
  });
  console.log(`  the instance ended the run and the hub's channel says so: ${told.content.slice(0, 120)}`);

  step('the owner takes the project back by its name; the hub\'s copy is gone');
  const back = await call(`${instanceUrl}/api/project-sharing/${projectId}`, json(atInstance, 'DELETE', { confirm: projectName }));
  assert.equal(back.status, 200, `taking it back was refused: ${JSON.stringify(back.body)}`);
  await eventually('the hub\'s copy going', async () => ((await call(`${hubUrl}/api/hub/projects/${onHub.id}`, { cookie: ownerHub })).status === 404 ? true : undefined));
  assert.equal((await call(`${hubUrl}/api/hub/projects/${onHub.id}/board`, { cookie: collaboratorMember.hub })).status, 404, 'the collaborator still reads a project taken back');
}

async function main(): Promise<void> {
  step('a root, an instance with its engine worker and a hub of their own start in containers from this commit\'s image');
  const stack = await startSplitStack({ engine: true, hubGitea: true });
  console.log(`  root ${stack.rootUrl}, instance ${stack.instanceUrl}, hub ${stack.hubUrl}; namespace ${stack.names.namespace}`);
  try {
    await stages(stack);
  } catch (err) {
    for (const side of ['root', 'instance', 'instance-engine', 'hub'] as const) console.error(`\n── ${side}'s last lines ──\n${stack.logs(side, 40)}`);
    throw err;
  } finally {
    if (!process.env.SPLIT_LIVE_KEEP) await stack.stop();
  }
  console.log('\nhub split live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
