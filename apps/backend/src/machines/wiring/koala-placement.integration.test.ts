import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KOALA_INSTALL_PROGRESS, koalaInstallProgressPath, type PlacedKoala } from '@koala/engine-core/koala-install';
import { machineProgressContract } from '@koala/engine-core/testing/machine-progress';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkToRoot, type RootLink } from '../../../../local-agent/src/root-link.js';
import { placedFrom } from '../../../../local-agent/src/koala-install.js';
import { rootProgress } from '../../../../local-agent/src/root-progress.js';
import { followInstall } from '../../../../local-agent/src/join/follow-install.js';
import { emptiedEachTime, testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { hashCredential, instanceIdFor } from '../../instances/services/InstanceService.js';
import { koalaInstallWorkflowId } from '../../instances/lib/koala-installs.js';
import { deviceTokenHash } from '../lib/device-tokens.js';
import { InstanceReporter } from '../../instances/services/InstanceReporter.js';
import { reopening } from '@koala/engine-core/reopening';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { KoalaInstalls } from '../services/KoalaInstalls.js';
import type { InstanceService } from '../../instances/services/InstanceService.js';
import { until } from '../testing/wiring-world.js';
import { installWorkflowWorld, placingRoot, type InstallWorkflowWorld, type PlacingRoot } from '../testing/placing-root.js';

const fresh = await emptiedEachTime();
const TOKEN = 'the-desk-token-0123456789-0123456789';

let temporal: InstallWorkflowWorld;
let db: MongoDB;
let world: PlacingRoot;
let url = '';
let accounts: MachineAccounts;
let installs: KoalaInstalls;
let service: InstanceService;
let folder = '';
let temporalDown = false;
const links: RootLink[] = [];

let current: () => MongoDB = () => { throw new Error('no database yet'); };

beforeAll(async () => {
  temporal = await installWorkflowWorld(() => current());
});

afterAll(async () => {
  await temporal?.close();
});

const deskOf = (store: MongoDB) => store.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-11-05T00:00:00Z', tokenHash: deviceTokenHash(TOKEN), koalaWanted: { name: 'bobby' } });

beforeEach(async () => {
  db = await fresh();
  current = () => db;
  temporalDown = false;
  folder = await mkdtemp(path.join(tmpdir(), 'koala-placement-'));
  world = await placingRoot({ db, workflows: temporal.workflows(() => temporalDown) });
  ({ url, accounts, installs, instances: service } = world);
  await deskOf(db);
});

afterEach(async () => {
  for (const link of links.splice(0)) link.close();
  await world.close();
  await rm(folder, { recursive: true, force: true });
});

const agentOf = (rootUrl: string, onPlaceKoala: (raw: unknown) => boolean, token = TOKEN, onStopKoala?: (raw: unknown) => void) => {
  const link = linkToRoot({
    rootUrl, token, configFile: path.join(folder, 'machine.json'), meshIp: async () => '100.64.0.7',
    onKoala: () => undefined, onRemoved: () => undefined, onPlaceKoala, onStopKoala, say: () => undefined,
  });
  links.push(link);
  return link;
};
const agent = (onPlaceKoala: (raw: unknown) => boolean, token = TOKEN, onStopKoala?: (raw: unknown) => void) => agentOf(url, onPlaceKoala, token, onStopKoala);

const handing = (handed: PlacedKoala[]) => (raw: unknown) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); };
const tokenOf = (link: RootLink) => () => (link.socket.auth as { token: string }).token;
const reporting = (placed: PlacedKoala, link: RootLink, at = url) => rootProgress(`${at}${koalaInstallProgressPath(placed.installId)}`, tokenOf(link), fetch, { pause: async () => undefined });
const instanceOf = async () => (await db.instances.getInstances('bo'))[0]!;

describe('Koala put on a machine by root\'s install workflow, the machine doing the work', () => {
  it('asks the machine the moment it connects on the mesh, records each stage it reports and each piece Koala sets up, and is ready with where Koala answers once the last piece is up', async () => {
    const handed: PlacedKoala[] = [];
    const link = agent(handing(handed));
    const placed = await until(async () => handed[0]);
    expect(placed).toMatchObject({ instanceId: instanceIdFor('bo'), machineId: 'desk', meshAddress: '100.64.0.7', name: 'bobby', image: '100.64.0.1:5001/nowrinkles/app', installId: expect.any(String) as unknown });
    expect(await instanceOf()).toMatchObject({ status: 'installing', machineId: 'desk', credentialHash: hashCredential(placed.credential), install: { id: placed.installId, state: 'asked', imageTag: 'v1' } });
    expect((await db.machines.getLocalAgentDevices())[0]?.koalaWanted).toBeUndefined();

    const root = reporting(placed, link);
    await root.tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'started' });
    await root.tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'done' });
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' });
    await until(async () => ((await instanceOf()).install?.line ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'desk is putting Koala on itself: Putting Koala on this machine, waiting for job/instance-seed-1 runs', install: { state: 'installing', stage: 'koala' } });
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' });
    await until(async () => ((await instanceOf()).url ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up', url: 'http://100.64.0.7:30320', install: { state: 'installing' } });
    const koala = new InstanceReporter({ root: { url, instanceId: placed.instanceId, credential: placed.credential }, wait: reopening(1), log: () => undefined });
    expect(await koala.setup({ revision: 1, progress: { stage: 'gitea', title: 'Gitea, your repositories and images', state: 'started', line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' } })).toEqual({ ok: true });
    await until(async () => ((await instanceOf()).install?.stage === 'gitea' ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready' });
    expect(await koala.setup({ revision: 1, progress: { stage: 'set-up', title: 'Koala is set up', state: 'done' } })).toEqual({ ok: true });
    await until(async () => ((await instanceOf()).status === 'ready' ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'ready', url: 'http://100.64.0.7:30320', running: 'v1', install: { state: 'ready' }, setup: { revision: 1, state: 'up' } });
    expect(world.told.length > 3 && world.told.every((said) => JSON.stringify(said) === '{}')).toBe(true);
    await expect(root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'started' })).rejects.toThrow('root did not take this machine\'s progress (409): that install has ended ready');
  });

  it('shows the join on the machine each stage root records, from its own follow of the install, until Koala is ready', async () => {
    const handed: PlacedKoala[] = [];
    const link = agent(handing(handed));
    const placed = await until(async () => handed[0]);
    const said: string[] = [];
    const following = followInstall({
      rootUrl: url, token: tokenOf(link)(), fetch, say: (line) => { said.push(line); }, section: (title) => { said.push(`# ${title}`); },
      interrupted: new AbortController().signal, wait: { pause: async () => undefined },
    });
    await until(async () => (said.includes('# Putting Koala on this machine') ? true : undefined));
    const root = reporting(placed, link);
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' });
    await until(async () => (said.includes('  waiting for job/instance-seed-1 runs') ? true : undefined));
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' });
    const koala = new InstanceReporter({ root: { url, instanceId: placed.instanceId, credential: placed.credential }, wait: reopening(1), log: () => undefined });
    expect(await koala.setup({ revision: 1, progress: { stage: 'set-up', title: 'Koala is set up', state: 'done' } })).toEqual({ ok: true });
    expect(await following).toBe('ready');
    expect(said.at(-1)).toBe('Koala is ready at http://100.64.0.7:30320');
  });

  it('asks the machine again when it comes back before the install finished, and fails with the stage and why it reports', async () => {
    const handed: PlacedKoala[] = [];
    const first = agent(handing(handed));
    const placed = await until(async () => handed[0]);
    await reporting(placed, first).tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'started' });
    await until(async () => (tokenOf(first)() !== TOKEN ? true : undefined));
    first.close();
    const second = agent(handing(handed), tokenOf(first)());
    const again = await until(async () => handed[1]);
    expect(again.installId).toBe(placed.installId);
    await reporting(again, second).tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'failed', why: 'job/instance-seed-2 failed: Mongo refused its password' });
    await until(async () => ((await instanceOf()).status === 'failed' ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'failed', detail: 'Putting Koala on desk stopped at Putting Koala on this machine: job/instance-seed-2 failed: Mongo refused its password', install: { state: 'failed', stage: 'koala', why: 'job/instance-seed-2 failed: Mongo refused its password' } });
  });

  it('stops following the install when the machine is removed on the way, cancelling its workflow', async () => {
    const handed: PlacedKoala[] = [];
    agent(handing(handed));
    const placed = await until(async () => handed[0]);
    expect(await accounts.remove('bo', 'desk')).toBe(true);
    const workflow = temporal.env.client.workflow.getHandle(koalaInstallWorkflowId(placed.installId));
    expect(await until(async () => ((await workflow.describe()).status.name === 'CANCELLED' ? true : undefined))).toBe(true);
    expect(await db.machines.getLocalAgentDevices()).toEqual([]);
  });

  it('fails the install, saying why, and tells the owner, when root cannot start its workflow', async () => {
    temporalDown = true;
    agent(() => true);
    const failed = await until(async () => { const instance = (await db.instances.getInstances('bo'))[0]; return instance?.install?.state === 'failed' ? instance : undefined; });
    expect(failed).toMatchObject({ status: 'failed', detail: 'root could not start putting Koala on desk: Temporal is not answering', install: { state: 'failed', why: 'root could not start putting Koala on desk: Temporal is not answering' } });
    expect((await db.machines.getLocalAgentDevices())[0]).toMatchObject({ koalaRefused: { reason: 'root could not start putting Koala on desk: Temporal is not answering' } });
    await until(async () => (world.told.length > 0 ? true : undefined));
  });

  it('hears only the machine the install is for, with its own token', async () => {
    const handed: PlacedKoala[] = [];
    const link = agent(handing(handed));
    const placed = await until(async () => handed[0]);
    const TOKEN_NOW = tokenOf(link)();
    const post = (token: string | undefined, installId: string) => fetch(`${url}${koalaInstallProgressPath(installId)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ stage: 'koala', title: 'Koala', state: 'started' }) });
    expect((await post(undefined, placed.installId)).status).toBe(401);
    expect((await post(`${TOKEN_NOW}-not`, placed.installId)).status).toBe(401);
    expect((await post(TOKEN_NOW, 'another-install')).status).toBe(404);
    expect((await post(TOKEN_NOW, placed.installId)).status).toBe(204);
  });
});

describe('a machine following its install while root\'s database stops answering', () => {
  it('is cut off and says the connection to root dropped, and keeps following until the person stops watching', async () => {
    const own = await testDatabase();
    current = () => own;
    const alone = await placingRoot({ db: own, workflows: temporal.workflows() });
    try {
      await deskOf(own);
      const handed: PlacedKoala[] = [];
      const link = agentOf(alone.url, handing(handed));
      await until(async () => handed[0]);
      const said: string[] = [];
      const watching = new AbortController();
      const following = followInstall({
        rootUrl: alone.url, token: tokenOf(link)(), fetch, say: (line) => { said.push(line); }, section: (title) => { said.push(`# ${title}`); },
        interrupted: watching.signal, wait: { pause: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 20))) },
      });
      await until(async () => (said.includes('# Putting Koala on this machine') ? true : undefined));
      await alone.sides.installsWatched!.close();
      await own.close();
      alone.installs.wake('bo');
      await until(async () => (said.some((line) => /^The connection to root dropped \(.+\); following again$/.test(line)) ? true : undefined));
      watching.abort(new Error('the person stopped watching'));
      expect(await following).toBe('interrupted');
    } finally {
      await own.init();
      await alone.close();
    }
  });
});

describe('Koala moved from Koala\'s servers onto a machine that joins with the move\'s command', () => {
  const pooled = async () => {
    await db.machines.deleteLocalAgentDevice('desk');
    const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: new Date().toISOString(), trialEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString() };
    await db.instances.saveInstance({ id: instanceIdFor('bo'), ownerId: 'bo', name: 'bobby', url: 'https://bobby.koala.dev', status: 'ready', createdAt: 't', updatedAt: 't', credentialHash: hashCredential('pool-secret'), meshIp: '100.64.0.1', pool });
    const started = await service.startMove('bo');
    if (!started.ok) throw new Error(started.error);
    return started.value;
  };
  const joinedWith = async (command: string): Promise<Record<string, string>> => {
    const code = command.split(' ').at(-1);
    const joining = await fetch(`${url}/api/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, hostname: 'desk', rootDir: '/home/bo/koala' }) });
    expect(joining.status).toBe(200);
    return (await joining.json() as { env: Record<string, string> }).env;
  };

  it('joins the machine, hands it the move with its own credential, follows the move to the switch, and leaves the pool copy serving until then', async () => {
    const started = await pooled();
    expect(started.command).toMatch(/^curl -fsSL http:\/\/root\.test\/machine\.sh \| sh -s -- \S+$/);
    expect(world.movesStarted).toEqual([instanceIdFor('bo')]);
    const joined = await joinedWith(started.command);

    const handed: PlacedKoala[] = [];
    const link = agent(handing(handed), joined.KOALA_DEVICE_TOKEN);
    const placed = await until(async () => handed[0]);
    expect(placed).toMatchObject({ instanceId: instanceIdFor('bo'), machineId: joined.KOALA_DEVICE_ID, name: 'bobby', move: { fromClusterId: 'pool-bobby' } });
    expect(await instanceOf()).toMatchObject({
      status: 'ready', url: 'https://bobby.koala.dev', credentialHash: hashCredential('pool-secret'),
      install: { id: placed.installId, move: true }, move: { credentialHash: hashCredential(placed.credential), target: { machine: 'desk', meshIp: '100.64.0.7' } },
    });

    const root = reporting(placed, link);
    await root.tell({ stage: 'koala', title: 'Bringing Koala over', state: 'started', line: 'waiting for job/move-mongo-1 runs' });
    await until(async () => ((await instanceOf()).move?.state === 'copying' ? true : undefined));
    expect((await instanceOf()).move).toMatchObject({ detail: 'Moving Koala to desk: Bringing Koala over, waiting for job/move-mongo-1 runs' });
    const koala = new InstanceReporter({ root: { url, instanceId: placed.instanceId, credential: placed.credential }, wait: reopening(1), log: () => undefined });
    expect(await koala.status({ status: 'installing', detail: 'copying your projects from Koala\'s servers' })).toEqual({ ok: true });
    await until(async () => ((await instanceOf()).move?.detail?.endsWith('copying your projects from Koala\'s servers') ? true : undefined));
    expect((await instanceOf()).move).toMatchObject({ state: 'copying', detail: 'Moving Koala to desk: Bringing Koala over, copying your projects from Koala\'s servers' });
    await root.tell({ stage: 'koala-moved', title: 'Starting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' });
    await until(async () => ((await instanceOf()).move?.target?.url ? true : undefined));
    expect(await koala.setup({ revision: 1, progress: { stage: 'set-up', title: 'Koala is set up', state: 'done' } })).toEqual({ ok: true });
    await until(async () => ((await instanceOf()).install?.state === 'ready' ? true : undefined));
    expect(await instanceOf()).toMatchObject({
      status: 'ready', url: 'https://bobby.koala.dev', credentialHash: hashCredential('pool-secret'),
      move: { state: 'switching', target: { url: 'http://100.64.0.7:30320' }, setup: { revision: 1, state: 'up' } },
    });
    expect((await instanceOf()).machineId).toBeUndefined();
  });

  it('stops the move when the person stops it, tells the machine to remove what the move made, and tells it again when it comes back, while the pool copy keeps serving', async () => {
    const joined = await joinedWith((await pooled()).command);
    const handed: PlacedKoala[] = [];
    const stops: unknown[] = [];
    const link = agent(handing(handed), joined.KOALA_DEVICE_TOKEN, (raw) => { stops.push(raw); });
    const placed = await until(async () => handed[0]);
    await reporting(placed, link).tell({ stage: 'koala', title: 'Bringing Koala over', state: 'started' });
    await until(async () => ((await instanceOf()).move?.state === 'copying' ? true : undefined));

    expect(await service.stopMove('bo')).toEqual({ ok: true, value: { stopping: true } });
    const workflow = temporal.env.client.workflow.getHandle(koalaInstallWorkflowId(placed.installId));
    expect(await until(async () => ((await workflow.describe()).status.name === 'CANCELLED' ? true : undefined))).toBe(true);
    expect(await until(async () => stops[0])).toEqual({ installId: placed.installId, remove: true });
    expect(await instanceOf()).toMatchObject({ status: 'ready', url: 'https://bobby.koala.dev', credentialHash: hashCredential('pool-secret') });

    const token = tokenOf(link)();
    link.close();
    const back: unknown[] = [];
    agent(() => false, token, (raw) => { back.push(raw); });
    expect(await until(async () => back[0])).toEqual({ installId: placed.installId, remove: true });
  });
});

machineProgressContract('root\'s install route, a new install for each report', KOALA_INSTALL_PROGRESS, async () => {
  await accounts.recordMeshIp('desk', '100.64.0.7');
  return {
    credential: async () => TOKEN,
    post: async (token, body) => {
      const started = await installs.start('bo', (await db.machines.getLocalAgentDevices())[0]!, 'bobby');
      if (!started.ok) throw new Error(started.error);
      return (await fetch(`${url}${koalaInstallProgressPath(started.value.installId)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).status;
    },
  };
});
