import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { MACHINE_JOINS_CHANGED } from '@koala/engine-core/machine-join';
import { roleFromEnv } from '../../platform/lib/platform-role.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem } from '../../instances/lib/identity-token.js';
import type { MachineDevices } from '../services/MachineService.js';
import { accountMachinesRouter } from '../routes/account-machines.js';
import { machineSides, type MachineSides } from './sides.js';
import { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import { InstancePresence } from '../../instances/services/InstancePresence.js';
import { InstanceSide, wireInstancePresence } from '../../instances/wiring/instances.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { closedAfterEach, hearing, until, type Hearing } from '../testing/wiring-world.js';
import { koalaPlacedAndUp, testInstanceClients } from '../../instances/testing/placed-koala.js';
import { machineClientsAt, machineSignInKey, machineTokenAt } from '../../instances/testing/registration-code.js';
import { InstanceReporter } from '../../instances/services/InstanceReporter.js';
import { AccountRemovalService, temporalKoalaRemovals, temporalRemovalWorkflows } from '../../accounts/services/AccountRemovalService.js';
import { OwnerRemoval } from '../../accounts/services/OwnerRemoval.js';
import { wireOwnerRemoval } from '../../accounts/wiring/owner-removal.js';
import { KOALA_REMOVAL_QUERY, OWNER_REMOVING, ROOT_REMOVAL_STEPS, ROOT_REMOVAL_WORKFLOW, removeAccountWorkflowId } from '../../accounts/lib/account-removal.js';
import { principalOf } from '../../platform/lib/permissions.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { QUEUES } from '../../platform/lib/work-places.js';
import type { DeletionProgress } from '../../projects/lib/project-deletion.js';
import { createStreamActivities } from '../../engine-host/temporal/activities.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import { ownerRemovalTold } from '../../engine/wiring/engine.js';
import { newWorld, temporalTestEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { environmentForFile, testWorker, uniqueName } from '../../workflows/testing/test-worker.js';
import { fakeRemovalSteps, nothingFrozen } from '../../workflows/testing/account-removal-steps.js';

const temporal = environmentForFile(temporalTestEnvironment);

const KEY = 'sides-test-secret';
const closers = closedAfterEach();

function recordingDevices(): MachineDevices & { dropped: string[]; told: string[] } {
  const dropped: string[] = [];
  const told: string[] = [];
  return {
    dropped,
    told,
    status: () => ({ online: false }),
    tell: (deviceId, event) => { told.push(`${deviceId} ${event}`); return true; },
    ask: async () => undefined as never,
    drop: (deviceId) => { dropped.push(deviceId); },
  };
}

async function listening(app: express.Express): Promise<{ url: string; io: SocketServer }> {
  const server = http.createServer(app);
  const io = new SocketServer(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(async () => { await io.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, io };
}

const mesh = { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined };

type Told = Hearing<{ url: string; resource: string } | null>;

async function machineConnected(root: { url: string }, rootDb: Database, deviceId: string): Promise<Told> {
  await rootDb.machines.updateLocalAgentDevice(deviceId, { set: { signIn: machineSignInKey() } });
  const socket: ClientSocket = connect(`${root.url}/machine-account`, { auth: { token: await machineTokenAt(rootDb, deviceId) }, transports: ['websocket'], reconnection: false, forceNew: true });
  closers.push(async () => { socket.close(); });
  return hearing(socket, 'machine:koala');
}

async function joinedAndConnected(world: { root: { url: string }; rootDb: Database; rootSide: MachineSides }): Promise<{ deviceId: string; told: Told }> {
  const accounts = world.rootSide.accounts!;
  const joined = await accounts.join((await accounts.createJoinCode('bo')).code, { hostname: 'desk', rootDir: '/home/bo/koala' });
  if (!joined.ok) throw new Error(joined.error);
  const told = await machineConnected(world.root, world.rootDb, joined.value.deviceId);
  await told.saidTimes(1);
  return { deviceId: joined.value.deviceId, told };
}

async function ownerBrowserHearing(root: { url: string; io: SocketServer }): Promise<Hearing<unknown>> {
  root.io.on('connection', (browser) => { void browser.join('user:bo'); });
  const browser: ClientSocket = connect(root.url, { transports: ['websocket'], reconnection: false, forceNew: true });
  closers.push(async () => { browser.close(); });
  const heard = hearing<unknown>(browser, MACHINE_JOINS_CHANGED);
  await new Promise<void>((connected, refused) => { browser.once('connect', () => connected()); browser.once('connect_error', refused); });
  return heard;
}

async function rootAndInstance(before?: (instanceDb: Database) => Promise<void>, atRoot?: { removal?: AccountRemovalService }) {
  const pem = generateIdentityKey();
  const rootDb = await testDatabase();
  const instanceDb = await testDatabase();
  await before?.(instanceDb);
  const rootApp = express();
  rootApp.use(express.json());
  const root = await listening(rootApp);
  const instanceApp = express();
  const instance = await listening(instanceApp);
  let rootSide: MachineSides | undefined;
  const instances = new InstanceService(rootDb, {
    serviceChanged: (changed) => rootSide?.instanceArrived(changed),
    rootUrl: root.url, rootPublicKeys: () => [publicKeyPem(identityKeysFrom(pem).publicKey)], ...testInstanceClients, registry: 'r', imageTag: 't', domain: 'koala.test', meshLoginServer: 'https://mesh.koala.test',
    reach: new InstanceReach({ open: true, domain: 'koala.test' }),
  }, mesh);
  const joined = { value: await koalaPlacedAndUp(instances, rootDb, 'bo', { id: 'bo-desktop', name: 'bo-desktop', meshIp: '100.64.0.9' }, 'bobby') };
  const { instanceId, token } = joined.value;
  const reported = await instances.report(instanceId, token, { status: 'ready', url: instance.url });
  if (!reported.ok) throw new Error(reported.error);
  const presence = new InstancePresence({ store: rootDb.instances, tellOwner: async () => undefined, afterMs: 60_000 });
  closers.push(async () => { presence.stop(); });
  const tellInstance = wireInstancePresence(root.io, presence, {
    caller: (id, token) => instances.presenceCaller(id, token),
    removals: (on) => { const watching = rootDb.instances.watchInstanceRemovals(on); closers.push(() => watching.close()); return watching; },
    arrived: (arrived) => rootSide?.instanceArrived(arrived),
  });
  rootSide = machineSides({
    role: roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: pem }),
    db: rootDb, io: root.io, dataKey: KEY, publicUrl: root.url, mesh, meshLoginServer: 'https://mesh.koala.test', clients: machineClientsAt(rootDb, root.url),
    devices: recordingDevices(), projects: new ProjectRepoService(rootDb, {} as GiteaService, KEY),
    instances: () => ({ service: instances, tellInstance }),
    dependencies: new DependencyStates({ process: 'backend', described: ['mongo', 'temporal'] }),
  });
  closers.push(async () => { await rootSide?.watched?.close(); });
  rootApp.use('/api/instances/machines', accountMachinesRouter({
    accounts: rootSide.accounts!,
    callerOf: async (req) => rootSide!.instanceCaller(String(req.headers['x-instance-id'] ?? ''), String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')),
  }));
  const removalAtRoot = () => {
    if (!atRoot?.removal) throw new Error('this world was given no account removal at root');
    return atRoot.removal;
  };
  rootApp.use('/api/instances', instancesRouter({
    instances, chart: async () => '',
    ...(atRoot ? { ownerRemoval: { removing: (ownerId: string) => removalAtRoot().ownerRemoving(ownerId), told: (ownerId: string, progress: DeletionProgress) => removalAtRoot().koalaTold(ownerId, progress) } } : {}),
  }));
  const role = roleFromEnv({ ROLE: 'instance', INSTANCE_ID: instanceId, INSTANCE_OWNER_ID: 'bo', ROOT_URL: root.url, ROOT_PUBLIC_KEYS: publicKeyPem(identityKeysFrom(pem).publicKey) });
  const side = new InstanceSide(role, { edge: { off: 'this test runs no edge' }, unreachableAfterMs: 600_000 }, async () => token);
  const devices = recordingDevices();
  const projects = new ProjectRepoService(instanceDb, {} as GiteaService, KEY);
  const instanceSide: MachineSides = machineSides({
    role, db: instanceDb, io: instance.io, dataKey: KEY, publicUrl: instance.url, mesh,
    devices, projects, rootToken: async () => token, side,
    instances: () => undefined,
    dependencies: new DependencyStates({ process: 'backend', described: ['mongo', 'temporal'] }),
  });
  return { root, rootDb, rootSide, instances, token, instanceDb, instanceSide, devices, projects, instanceId, side, tellInstance, watch: () => { side.watchRoot(async () => undefined, new DependencyStates({ process: 'backend', described: ['root'] })); closers.push(async () => { (side as unknown as { rootPresence?: { stop(): void } }).rootPresence?.stop(); }); } };
}

const machinesOn = async (db: Database) => db.machines.getLocalAgentDevices();

describe('a root and an instance wired as they run, against each other', () => {
  it('root\'s removal of the owner reaches their Koala over its presence connection, the Koala removes its owner, and root hears how it stands and removes nothing of its own until the Koala says deleted', async () => {
    const atRoot: { removal?: AccountRemovalService } = {};
    const { root, rootDb, token, instanceId, side, tellInstance, watch } = await rootAndInstance(undefined, atRoot);
    await rootDb.accounts.saveUser({ id: 'bo', email: 'bo@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
    const { env } = temporal;
    const principalFor = (user: Pick<UserMetadata, 'id' | 'roles'>) => principalOf(user, { role: 'root' });
    const rootQueue = uniqueName('root-removal');
    atRoot.removal = new AccountRemovalService({
      store: rootDb,
      workflows: temporalRemovalWorkflows(() => env.client, rootQueue),
      workflowType: ROOT_REMOVAL_WORKFLOW,
      steps: ROOT_REMOVAL_STEPS,
      instances: () => rootDb.instances.getInstances(),
      machines: () => rootDb.machines.getLocalAgentDevices(),
      principalFor,
      koalas: temporalKoalaRemovals(() => env.client, (id) => tellInstance(id, OWNER_REMOVING)),
    });
    const seen: string[] = [];
    const rootWorker = await testWorker(env, {
      taskQueue: rootQueue,
      workflows: 'RootAccountRemovalWorkflow.ts',
      activities: {
        RootRemovalInstanceActivity: async () => { seen.push('root: its Koala'); return { koala: instanceId }; },
        RootRemovalMachinesActivity: async () => { seen.push('root: machines'); return []; },
        RootRemovalMeshActivity: async () => { seen.push('root: mesh'); return { devices: 0, user: true }; },
        RootRemovalRecordsActivity: async () => { seen.push('root: records'); return { users: 1 }; },
      },
    });
    const koala = await newWorld(env);
    const koalaQueue = uniqueName('owner-removal');
    const reporter = new InstanceReporter({ root: { url: root.url, instanceId, token: async () => token } });
    const nothingRunning = { trees: [], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined };
    const told = createStreamActivities({ registry: {} as never, endpoints: {} as never, bus: {} as never, accountDeletionChanged: ownerRemovalTold({ ownerRemovalToRoot: reporter, core: { runningRecords: async () => nothingRunning } }) });
    const koalaWorker = await testWorker(env, { namespace: koala.namespace, taskQueue: koalaQueue, workflows: 'DeleteAccountWorkflow.ts', activities: fakeRemovalSteps(seen) });
    const clusterWorker = await testWorker(env, { namespace: koala.namespace, taskQueue: QUEUES.cluster, activities: nothingFrozen() });
    const streamWorker = await testWorker(env, { namespace: koala.namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: { AccountDeletionChangedActivity: told.AccountDeletionChangedActivity } });
    const ownerRemoval = new OwnerRemoval({ ownerId: 'bo', root: reporter, workflows: temporalRemovalWorkflows(() => koala.client, koalaQueue) });
    let gaveUp: (why: string) => void = () => undefined;
    const cannotCome = new Promise<never>((_, refuse) => { gaveUp = (why) => refuse(new Error(why)); });
    wireOwnerRemoval(side, {
      check: (why) => ownerRemoval.check(why).then((said) => {
        if (why === 'told' && said !== 'started' && said !== 'running') gaveUp(`the Koala heard root's word and said ${said}`);
        if (said === 'started') koala.client.workflow.getHandle(removeAccountWorkflowId('bo')).result().catch((err: Error) => gaveUp(`the Koala's removal of its owner failed: ${err.message}`));
        return said;
      }, (err: Error) => { gaveUp(`the Koala could not check whether root removes its owner: ${err.message}`); throw err; }),
    });
    watch();
    const atRootHandle = env.client.workflow.getHandle(removeAccountWorkflowId('bo'));
    await rootWorker.runUntil(koalaWorker.runUntil(clusterWorker.runUntil(streamWorker.runUntil(async () => {
      const started = await atRoot.removal!.remove({ ownerId: 'bo', requestedBy: 'bo', confirm: 'bo@example.com' }, principalFor({ id: 'bo' }));
      expect(started.ok, JSON.stringify(started)).toBe(true);
      await Promise.race([atRootHandle.result(), cannotCome]);
      expect(await atRootHandle.query<DeletionProgress | undefined>(KOALA_REMOVAL_QUERY)).toMatchObject({ phase: 'deleted', parts: { records: { state: 'deleted' } } });
    }))));
    expect(seen.slice(-3)).toEqual(['root: machines', 'root: mesh', 'root: records']);
    expect(seen.indexOf('records'), 'the Koala deleted its owner\'s records before root went on').toBeLessThan(seen.indexOf('root: machines'));
    expect(seen).toContain('root: its Koala');
  });

  it('copies the instance\'s machines from before to root once it connects, keeping their ids', async () => {
    const { rootDb, watch } = await rootAndInstance(async (db) => {
      await db.machines.saveLocalAgentDevice({ id: 'old-desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-10-01T00:00:00Z' });
    });
    watch();
    expect(await until(async () => (await machinesOn(rootDb)).find((machine) => machine.id === 'old-desk'))).toEqual({ id: 'old-desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-10-01T00:00:00Z' });
  });

  it('a machine joining at root reaches the instance\'s copy and becomes a project, its mesh address following; one removed through the instance leaves both, its connection dropped', async () => {
    const { rootSide, instanceDb, instanceSide, devices, watch } = await rootAndInstance();
    const projectsOn = async () => (await instanceDb.projects.getProjects()).map((project) => ({ ownerId: project.ownerId, name: project.name, deviceId: project.executionTarget?.kind === 'local-device' ? project.executionTarget.deviceId : undefined }));
    watch();
    const made = await instanceSide.machines.createJoinCode('bo');
    expect(made.command).toContain('/machine.sh | sh -s -- ');
    const joined = await rootSide.accounts!.join(made.code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!joined.ok) throw new Error(joined.error);
    const id = joined.value.deviceId;
    expect(joined.value.env).not.toHaveProperty('KOALA_DEVICE_TOKEN');
    expect(await until(async () => (await machinesOn(instanceDb)).find((machine) => machine.id === id))).not.toHaveProperty('tokenHash');
    expect(await until(async () => ((await projectsOn()).length ? projectsOn() : undefined))).toEqual([{ ownerId: 'bo', name: 'desk - koala', deviceId: id }]);
    await rootSide.accounts!.recordMeshIp(id, '100.64.0.9');
    await until(async () => (await machinesOn(instanceDb)).find((machine) => machine.id === id && machine.meshIp === '100.64.0.9'));
    expect(await instanceSide.machines.remove('bo', id)).toBe(true);
    await until(async () => ((await machinesOn(instanceDb)).some((machine) => machine.id === id) ? undefined : true));
    expect(devices.dropped).toEqual([id]);
    expect(await projectsOn()).toEqual([]);
  });

  it('root names the instance to a connected machine, and the resource the machine asks root tokens for there, once the instance connects to root', async () => {
    const world = await rootAndInstance();
    const { instanceId, watch } = world;
    const { told } = await joinedAndConnected(world);
    watch();
    const [, named] = await told.saidTimes(2);
    expect(named).toEqual({ url: expect.any(String) as unknown, resource: `urn:koala:instance:${instanceId}` });
  });

  it('root tells the owner\'s connected machines again each time the instance reports to root that its status changed', async () => {
    const world = await rootAndInstance();
    const { root, token, instanceId, watch } = world;
    const { told } = await joinedAndConnected(world);
    watch();
    await told.saidTimes(2);
    const report = async (status: string) => {
      const answer = await fetch(`${root.url}/api/instances/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-instance-id': instanceId, authorization: `Bearer ${token}` }, body: JSON.stringify({ status }) });
      expect(answer.status, await answer.clone().text()).toBe(200);
    };
    await report('installing');
    await told.saidTimes(3);
    await report('ready');
    const said = await told.saidTimes(4);
    expect(said).toHaveLength(4);
    expect(said[3]).toEqual({ url: expect.any(String) as unknown, resource: `urn:koala:instance:${instanceId}` });
  });

  it('root tells the owner\'s browsers as a join reports, and ends the join when the machine it made first connects', async () => {
    const { root, rootDb, rootSide } = await rootAndInstance();
    const heard = await ownerBrowserHearing(root);
    const accounts = rootSide.accounts!;
    const { code } = await accounts.createJoinCode('bo');
    expect(await accounts.reportJoinProgress(code, { stage: 'k3s', title: 'Installing k3s', state: 'started' })).toMatchObject({ ok: true });
    expect(await heard.saidTimes(1)).toEqual([{}]);
    const joined = await accounts.join(code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!joined.ok) throw new Error(joined.error);
    expect(await heard.saidTimes(2)).toEqual([{}, {}]);
    expect(await accounts.joins('bo')).toHaveLength(1);
    await (await machineConnected(root, rootDb, joined.value.deviceId)).saidTimes(1);
    expect(await heard.saidTimes(4)).toEqual([{}, {}, {}, {}]);
    expect(await accounts.joins('bo')).toEqual([]);
  });

  it('root tells the owner\'s browsers when a machine joins, joins again in its own place, has a join dismissed and connects, and says the machine is connected once its agent is', async () => {
    const { root, rootDb, rootSide } = await rootAndInstance();
    const heard = await ownerBrowserHearing(root);
    const accounts = rootSide.accounts!;
    const first = await accounts.join((await accounts.createJoinCode('bo')).code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!first.ok) throw new Error(first.error);
    expect(await heard.saidTimes(1)).toEqual([{}]);
    const { code } = await accounts.createJoinCode('bo');
    expect(await accounts.reportJoinProgress(code, { stage: 'k3s', title: 'Installing k3s', state: 'started' })).toMatchObject({ ok: true });
    expect(await heard.saidTimes(2)).toEqual([{}, {}]);
    await rootDb.machines.updateLocalAgentDevice(first.value.deviceId, { set: { signIn: machineSignInKey() } });
    const again = await accounts.join(code, { hostname: 'desk', rootDir: '/home/bo/koala', replaces: await machineTokenAt(rootDb, first.value.deviceId) });
    if (!again.ok) throw new Error(again.error);
    expect(again.value.deviceId).toBe(first.value.deviceId);
    expect(await heard.saidTimes(3)).toEqual([{}, {}, {}]);
    const [shown] = await accounts.joins('bo');
    expect(await accounts.dismissJoin('bo', shown!.id)).toEqual({ ok: true, value: { dismissed: true } });
    expect(await heard.saidTimes(4)).toEqual([{}, {}, {}, {}]);
    expect(await accounts.joins('bo')).toEqual([]);
    expect((await accounts.listOnline('bo')).map((machine) => machine.online)).toEqual([false]);
    await machineConnected(root, rootDb, again.value.deviceId);
    expect(await heard.saidTimes(5)).toHaveLength(5);
    expect((await accounts.listOnline('bo')).map((machine) => machine.online)).toEqual([true]);
  });
});
