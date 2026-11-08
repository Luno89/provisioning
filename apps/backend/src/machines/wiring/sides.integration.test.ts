import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { roleFromEnv } from '../../platform/lib/platform-role.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem } from '../../instances/lib/identity-token.js';
import { checkWorkToken } from '../lib/work-tokens.js';
import type { MachineDevices } from '../services/MachineService.js';
import { accountMachinesRouter } from '../routes/account-machines.js';
import { machineSides, type MachineSides } from './sides.js';
import { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import { InstancePresence } from '../../instances/services/InstancePresence.js';
import { InstanceSide, wireInstancePresence } from '../../instances/wiring/instances.js';

const KEY = 'sides-test-secret';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function until<T>(look: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 20));
  }
}

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

async function rootAndInstance(before?: (instanceDb: Database) => Promise<void>) {
  const pem = generateIdentityKey();
  const rootDb = await testDatabase();
  const instanceDb = await testDatabase();
  await before?.(instanceDb);
  const rootApp = express();
  rootApp.use(express.json());
  const root = await listening(rootApp);
  const instanceApp = express();
  const instance = await listening(instanceApp);
  const instances = new InstanceService(rootDb, {
    rootUrl: root.url, rootPublicKeys: () => [publicKeyPem(identityKeysFrom(pem).publicKey)], registry: 'r', imageTag: 't', domain: 'koala.test', meshLoginServer: 'https://mesh.koala.test',
    reach: new InstanceReach({ open: true, domain: 'koala.test' }),
  }, mesh);
  const made = await instances.createJoinToken('bo', 'bobby');
  if (!made.ok) throw new Error(made.error);
  const joined = await instances.join(made.value.token, 'bo-desktop');
  if (!joined.ok) throw new Error(joined.error);
  const { instanceId, credential } = joined.value;
  const reported = await instances.report(instanceId, credential, { status: 'ready', url: instance.url });
  if (!reported.ok) throw new Error(reported.error);
  const presence = new InstancePresence({ store: rootDb.instances, tellOwner: async () => undefined, tellOperators: async () => undefined, afterMs: 60_000 });
  closers.push(async () => { presence.stop(); });
  let rootSide: MachineSides | undefined;
  const tellInstance = wireInstancePresence(root.io, presence, (id, token) => instances.caller(id, token), (arrived) => rootSide?.instanceArrived(arrived));
  rootSide = machineSides({
    role: roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: pem }),
    db: rootDb, io: root.io, dataKey: KEY, publicUrl: root.url, mesh,
    devices: recordingDevices(), projects: new ProjectRepoService(rootDb, {} as GiteaService, KEY),
    instances: () => ({ service: instances, tellInstance }),
  });
  rootApp.use('/api/instances/machines', accountMachinesRouter({
    accounts: rootSide.accounts!,
    callerOf: async (req) => rootSide!.instanceCaller(String(req.headers['x-instance-id'] ?? ''), String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')),
  }));
  const role = roleFromEnv({ ROLE: 'instance', INSTANCE_ID: instanceId, INSTANCE_OWNER_ID: 'bo', ROOT_URL: root.url, ROOT_PUBLIC_KEYS: publicKeyPem(identityKeysFrom(pem).publicKey) });
  const side = new InstanceSide(role, {}, async () => credential);
  const devices = recordingDevices();
  const projects = new ProjectRepoService(instanceDb, {} as GiteaService, KEY);
  const instanceSide: MachineSides = machineSides({
    role, db: instanceDb, io: instance.io, dataKey: KEY, publicUrl: instance.url, mesh,
    devices, projects, rootToken: async () => credential, side,
    instances: () => undefined,
  });
  return { root, rootDb, rootSide, instanceDb, instanceSide, devices, projects, instanceId, watch: () => { side.watchRoot(async () => undefined); closers.push(async () => { (side as unknown as { rootPresence?: { stop(): void } }).rootPresence?.stop(); }); } };
}

const machinesOn = async (db: Database) => db.machines.getLocalAgentDevices();

describe('a root and an instance wired as they run, against each other', () => {
  it('copies the instance\'s machines from before to root once it connects, keeping their ids', async () => {
    const { rootDb, watch } = await rootAndInstance(async (db) => {
      await db.machines.saveLocalAgentDevice({ id: 'old-desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-10-01T00:00:00Z', tokenHash: 'h'.repeat(64) });
    });
    watch();
    expect(await until(async () => (await machinesOn(rootDb)).find((machine) => machine.id === 'old-desk'))).toMatchObject({ ownerId: 'bo', tokenHash: 'h'.repeat(64) });
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
    await until(async () => (await machinesOn(instanceDb)).find((machine) => machine.id === id));
    expect(await until(async () => ((await projectsOn()).length ? projectsOn() : undefined))).toEqual([{ ownerId: 'bo', name: 'desk - koala', deviceId: id }]);
    await rootSide.accounts!.recordMeshIp(id, '100.64.0.9');
    await until(async () => (await machinesOn(instanceDb)).find((machine) => machine.id === id && machine.meshIp === '100.64.0.9'));
    expect(await instanceSide.machines.remove('bo', id)).toBe(true);
    await until(async () => ((await machinesOn(instanceDb)).some((machine) => machine.id === id) ? undefined : true));
    expect(devices.dropped).toEqual([id]);
    expect(await projectsOn()).toEqual([]);
  });

  it('root names the instance to a connected machine with a work token the instance takes, once the instance connects to root', async () => {
    const { root, rootSide, instanceSide, instanceId, watch } = await rootAndInstance();
    const joined = await rootSide.accounts!.join((await rootSide.accounts!.createJoinCode('bo')).code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!joined.ok) throw new Error(joined.error);
    const told: Array<{ url: string; workToken: string } | null> = [];
    const socket: ClientSocket = connect(`${root.url}/machine-account`, { auth: { token: joined.value.env.KOALA_DEVICE_TOKEN }, transports: ['websocket'], reconnection: false, forceNew: true });
    closers.push(async () => { socket.close(); });
    socket.on('machine:koala', (koala: { url: string; workToken: string } | null) => told.push(koala));
    await until(async () => (told.length ? true : undefined));
    watch();
    await until(async () => (told.length === 2 ? true : undefined));
    const trust = instanceSide.workTokens!;
    expect(checkWorkToken(told[1]!.workToken, trust.keys, trust.audience)).toMatchObject({ ok: true, claims: { sub: joined.value.deviceId, owner: 'bo', aud: instanceId } });
  });
});
