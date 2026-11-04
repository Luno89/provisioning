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

function recordingProjects() {
  const projects: Array<{ ownerId: string; name: string; deviceId?: string | undefined }> = [];
  return {
    projects,
    register: async (ownerId: string, name: string, opts: { executionTarget?: { kind: string; deviceId?: string } | undefined }) => {
      projects.push({ ownerId, name, deviceId: opts.executionTarget?.deviceId });
      return { id: `p-${projects.length}` } as never;
    },
    removeFor: async (ownerId: string, deviceId: string) => {
      const at = projects.findIndex((project) => project.ownerId === ownerId && project.deviceId === deviceId);
      if (at >= 0) projects.splice(at, 1);
    },
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
  const heard: Record<string, () => void> = {};
  const rootApp = express();
  rootApp.use(express.json());
  const root = await listening(rootApp);
  const instanceApp = express();
  const instance = await listening(instanceApp);
  await rootDb.instances.saveInstance({ id: 'inst-1', ownerId: 'bo', url: instance.url, status: 'ready', createdAt: '2026-11-04T00:00:00Z' } as never);
  const rootDevices = recordingDevices();
  const rootSide: MachineSides = machineSides({
    role: roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: pem }),
    db: rootDb, io: root.io, dataKey: KEY, publicUrl: root.url, mesh,
    devices: rootDevices, projects: recordingProjects(),
    koalaOf: async (ownerId) => (ownerId === 'bo' ? { url: instance.url, audience: 'inst-1' } : undefined),
    tellInstance: (instanceId, event) => { if (instanceId === 'inst-1') heard[event]?.(); },
  });
  rootApp.use('/api/instances/machines', accountMachinesRouter({
    accounts: rootSide.accounts!,
    callerOf: async (req) => (req.headers['x-instance-id'] === 'inst-1' && req.headers.authorization === 'Bearer service-token' ? { ownerId: 'bo' } : undefined),
  }));
  const devices = recordingDevices();
  const projects = recordingProjects();
  const instanceSide: MachineSides = machineSides({
    role: roleFromEnv({ ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'bo', ROOT_URL: root.url, ROOT_PUBLIC_KEYS: publicKeyPem(identityKeysFrom(pem).publicKey) }),
    db: instanceDb, io: instance.io, dataKey: KEY, publicUrl: instance.url, mesh,
    devices, projects, rootToken: async () => 'service-token',
    hear: (event, handler) => { heard[event] = handler; },
    koalaOf: async () => undefined,
    tellInstance: () => undefined,
  });
  return { root, rootDb, rootSide, instanceDb, instanceSide, devices, projects, heard };
}

const machinesOn = async (db: Database) => db.machines.getLocalAgentDevices();

describe('a root and an instance wired as they run, against each other', () => {
  it('copies the instance\'s machines from before to root once it connects, keeping their ids', async () => {
    const { rootDb, heard } = await rootAndInstance(async (db) => {
      await db.machines.saveLocalAgentDevice({ id: 'old-desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-10-01T00:00:00Z', tokenHash: 'h'.repeat(64) });
    });
    heard.connect!();
    expect(await until(async () => (await machinesOn(rootDb)).find((machine) => machine.id === 'old-desk'))).toMatchObject({ ownerId: 'bo', tokenHash: 'h'.repeat(64) });
  });

  it('a machine joining at root reaches the instance\'s copy and becomes a project; one removed through the instance leaves both, its connection dropped', async () => {
    const { rootSide, instanceDb, instanceSide, devices, projects } = await rootAndInstance();
    const made = await instanceSide.machines.createJoinCode('bo');
    expect(made.command).toContain('/machine.sh | sh -s -- ');
    const joined = await rootSide.accounts!.join(made.code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!joined.ok) throw new Error(joined.error);
    const id = joined.value.deviceId;
    await until(async () => (await machinesOn(instanceDb)).find((machine) => machine.id === id));
    expect(projects.projects).toEqual([{ ownerId: 'bo', name: 'desk - koala', deviceId: id }]);
    expect(await instanceSide.machines.remove('bo', id)).toBe(true);
    await until(async () => ((await machinesOn(instanceDb)).some((machine) => machine.id === id) ? undefined : true));
    expect(devices.dropped).toEqual([id]);
    expect(projects.projects).toEqual([]);
  });

  it('root names the instance to a connected machine with a work token the instance takes, once the instance arrives', async () => {
    const { root, rootSide, instanceSide } = await rootAndInstance();
    const joined = await rootSide.accounts!.join((await rootSide.accounts!.createJoinCode('bo')).code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!joined.ok) throw new Error(joined.error);
    const told: Array<{ url: string; workToken: string } | null> = [];
    const socket: ClientSocket = connect(`${root.url}/machine-account`, { auth: { token: joined.value.env.KOALA_DEVICE_TOKEN }, transports: ['websocket'], reconnection: false, forceNew: true });
    closers.push(async () => { socket.close(); });
    socket.on('machine:koala', (koala: { url: string; workToken: string } | null) => told.push(koala));
    await until(async () => (told.length ? true : undefined));
    rootSide.instanceArrived({ id: 'inst-1', ownerId: 'bo' });
    await until(async () => (told.length === 2 ? true : undefined));
    const trust = instanceSide.workTokens!;
    expect(checkWorkToken(told[1]!.workToken, trust.keys, trust.audience)).toMatchObject({ ok: true, claims: { sub: joined.value.deviceId, owner: 'bo', aud: 'inst-1' } });
  });
});

describe('a combined Koala wired as it runs', () => {
  it('makes a joined machine its project at once, and its work tokens are for itself', async () => {
    const db = await testDatabase();
    const app = express();
    const { io, url } = await listening(app);
    const projects = recordingProjects();
    const sides = machineSides({
      role: roleFromEnv({ ROLE: 'combined', JWT_SECRET: 'combined-test' }),
      db, io, dataKey: KEY, publicUrl: url, mesh, devices: recordingDevices(), projects,
      koalaOf: async () => undefined, tellInstance: () => undefined,
    });
    expect(sides.mirror).toBeUndefined();
    const joined = await sides.accounts!.join((await sides.machines.createJoinCode('bo')).code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!joined.ok) throw new Error(joined.error);
    expect(projects.projects).toEqual([{ ownerId: 'bo', name: 'desk - koala', deviceId: joined.value.deviceId }]);
    const koala = (await sides.accounts!.koalaFor(joined.value.deviceId))!;
    expect(koala.url).toBe(url);
    expect(checkWorkToken(koala.workToken, sides.workTokens!.keys, sides.workTokens!.audience)).toMatchObject({ ok: true, claims: { aud: 'combined' } });
    expect(await sides.machines.remove('bo', joined.value.deviceId)).toBe(true);
    expect(projects.projects).toEqual([]);
  });
});
