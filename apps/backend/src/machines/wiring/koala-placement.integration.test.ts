import { koalaInstallProgressPath, type PlacedKoala } from '@koala/engine-core/koala-install';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkToRoot, type RootLink } from '../../../../local-agent/src/root-link.js';
import { placedFrom } from '../../../../local-agent/src/koala-install.js';
import { rootProgress } from '../../../../local-agent/src/root-progress.js';
import { followInstall } from '../../../../local-agent/src/join/follow-install.js';
import { emptiedEachTime, testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { instanceIdFor } from '../../instances/services/InstanceService.js';
import { koalaInstallWorkflowId } from '../../instances/lib/koala-installs.js';
import { InstanceReporter } from '../../instances/services/InstanceReporter.js';
import { reopening } from '@koala/engine-core/reopening';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import { until, untilWhile } from '../testing/wiring-world.js';
import { installWorkflowWorld, placingRoot, type InstallWorkflowWorld, type PlacingRoot } from '../testing/placing-root.js';
import { tokenOfInstance } from '../../instances/testing/placed-koala.js';
import { machineSignInKey, machineTokenAt } from '../../instances/testing/registration-code.js';

const fresh = await emptiedEachTime();
const TOKEN = 'the-desk-token-0123456789-0123456789';

let temporal: InstallWorkflowWorld;
let db: MongoDB;
let world: PlacingRoot;
let url = '';
let accounts: MachineAccounts;
let temporalDown = false;
const links: RootLink[] = [];

let current: () => MongoDB = () => { throw new Error('no database yet'); };

beforeAll(async () => {
  temporal = await installWorkflowWorld(() => current());
});

afterAll(async () => {
  await temporal?.close();
});

const deskOf = (store: MongoDB) => store.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-11-05T00:00:00Z', signIn: machineSignInKey(), koalaWanted: { name: 'bobby' } });

beforeEach(async () => {
  db = await fresh();
  current = () => db;
  temporalDown = false;
  world = await placingRoot({ db, workflows: temporal.workflows(() => temporalDown) });
  ({ url, accounts } = world);
  await deskOf(db);
});

afterEach(async () => {
  for (const link of links.splice(0)) link.close();
  await world.close();
});

const keyToken = (store: MongoDB = db) => () => machineTokenAt(store, 'desk');
const agentOf = (rootUrl: string, onPlaceKoala: (raw: unknown) => boolean, store: MongoDB = db, onStopKoala?: (raw: unknown) => void) => {
  const link = linkToRoot({
    rootUrl, client: { token: keyToken(store), freshToken: keyToken(store) }, meshIp: async () => '100.64.0.7',
    onKoala: () => undefined, onRemoved: () => undefined, onPlaceKoala, onStopKoala, say: () => undefined,
  });
  links.push(link);
  return link;
};
const agent = (onPlaceKoala: (raw: unknown) => boolean, onStopKoala?: (raw: unknown) => void) => agentOf(url, onPlaceKoala, db, onStopKoala);

const handing = (handed: PlacedKoala[]) => (raw: unknown) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); };
const reporting = (placed: PlacedKoala, at = url) => rootProgress(`${at}${koalaInstallProgressPath(placed.installId)}`, keyToken(), fetch, { pause: async () => undefined });
const instanceOf = async () => (await db.instances.getInstances('bo'))[0]!;

describe('Koala put on a machine by root\'s install workflow, the machine doing the work', () => {
  it('asks the machine the moment it connects on the mesh, records each stage it reports and each piece Koala sets up, and is ready with where Koala answers once the last piece is up', async () => {
    const handed: PlacedKoala[] = [];
    agent(handing(handed));
    const placed = await until(async () => handed[0]);
    expect(placed).toMatchObject({ instanceId: instanceIdFor('bo'), machineId: 'desk', meshAddress: '100.64.0.7', name: 'bobby', image: '100.64.0.1:5001/nowrinkles/app', installId: expect.any(String) as unknown });
    expect(await instanceOf()).toMatchObject({ status: 'installing', machineId: 'desk', install: { id: placed.installId, state: 'asked', imageTag: 'v1' } });
    expect((await db.machines.getLocalAgentDevices())[0]?.koalaWanted).toBeUndefined();

    const root = reporting(placed);
    await root.tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'started' });
    await root.tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'done' });
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' });
    await until(async () => ((await instanceOf()).install?.line ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'desk is putting Koala on itself: Putting Koala on this machine, waiting for job/instance-seed-1 runs', install: { state: 'installing', stage: 'koala' } });
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320', revision: 1 });
    await until(async () => ((await instanceOf()).url ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up', url: 'http://100.64.0.7:30320', install: { state: 'installing' } });
    const koala = new InstanceReporter({ root: { url, instanceId: placed.instanceId, token: async () => tokenOfInstance(placed.instanceId) }, wait: reopening(1), log: () => undefined });
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
    agent(handing(handed));
    const placed = await until(async () => handed[0]);
    const said: string[] = [];
    const following = followInstall({
      rootUrl: url, token: keyToken(), fetch, say: (line) => { said.push(line); }, section: (title) => { said.push(`# ${title}`); },
      interrupted: new AbortController().signal, wait: { pause: async () => undefined },
    });
    await untilWhile(following, () => (said.includes('# Putting Koala on this machine') ? true : undefined));
    const root = reporting(placed);
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' });
    await untilWhile(following, () => (said.includes('  waiting for job/instance-seed-1 runs') ? true : undefined));
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320', revision: 1 });
    const koala = new InstanceReporter({ root: { url, instanceId: placed.instanceId, token: async () => tokenOfInstance(placed.instanceId) }, wait: reopening(1), log: () => undefined });
    expect(await koala.setup({ revision: 1, progress: { stage: 'set-up', title: 'Koala is set up', state: 'done' } })).toEqual({ ok: true });
    expect(await following).toBe('ready');
    expect(said.at(-1)).toBe('Koala is ready at http://100.64.0.7:30320');
  });

  it('asks the machine again when it comes back before the install finished, and fails with the stage and why it reports', async () => {
    const handed: PlacedKoala[] = [];
    const first = agent(handing(handed));
    const placed = await until(async () => handed[0]);
    await reporting(placed).tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'started' });
    first.close();
    agent(handing(handed));
    const again = await until(async () => handed[1]);
    expect(again.installId).toBe(placed.installId);
    await reporting(again).tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'failed', why: 'job/instance-seed-2 failed: Mongo refused its password' });
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
    agent(handing(handed));
    const placed = await until(async () => handed[0]);
    const TOKEN_NOW = await keyToken()();
    const post = (token: string | undefined, installId: string) => fetch(`${url}${koalaInstallProgressPath(installId)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ stage: 'koala', title: 'Koala', state: 'started' }) });
    expect((await post(undefined, placed.installId)).status).toBe(401);
    expect((await post(TOKEN, placed.installId)).status).toBe(401);
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
      agentOf(alone.url, handing(handed), own);
      await until(async () => handed[0]);
      const said: string[] = [];
      const watching = new AbortController();
      const following = followInstall({
        rootUrl: alone.url, token: keyToken(own), fetch, say: (line) => { said.push(line); }, section: (title) => { said.push(`# ${title}`); },
        interrupted: watching.signal, wait: { pause: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 20))) },
      });
      await untilWhile(following, () => (said.includes('# Putting Koala on this machine') ? true : undefined));
      await alone.sides.watched!.close();
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
