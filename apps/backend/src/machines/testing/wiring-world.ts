import { io as connect, type Socket } from 'socket.io-client';
import { afterEach } from 'vitest';
import type { MachineAccountsDeps } from '../services/MachineAccounts.js';
import { MachineService, type MachineDeps } from '../services/MachineService.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { wireSockets, type SocketsWiringDeps } from '../wiring/sockets.js';
import { testPayloadBlobs } from '../../platform/lib/test-database.js';

type SocketAuth = SocketsWiringDeps['auth'];

export function socketAuth(over: { signedIn?: (cookie: string | undefined) => Awaited<ReturnType<SocketAuth['sessionOf']>>; principalFor?: SocketAuth['principalFor'] } = {}): SocketAuth {
  return {
    sessionOf: async (req) => over.signedIn?.(req.headers.cookie),
    sessionHandle: (_req, _res, next) => { next(); },
    principalFor: over.principalFor ?? (() => { throw new Error('nobody signs in to these sockets'); }),
  };
}

export function agentSockets(given: Pick<SocketsWiringDeps, 'io' | 'db' | 'machines' | 'payloadKey' | 'dataKey'> & Partial<SocketsWiringDeps>, ownerId = 'owner-1'): SocketsWiringDeps {
  return {
    role: { role: 'instance', instance: { id: 'inst-1', ownerId, rootUrl: 'http://root.test' } },
    payloadBlobs: testPayloadBlobs().blobs,
    auth: socketAuth(),
    sessionSockets: { track: () => undefined, forget: () => undefined },
    clusters: {} as never,
    apps: {} as never,
    telemetry: { relay: async () => ({ ok: true }) } as never,
    ...given,
  };
}

export async function servedAgentSockets(given: Omit<Parameters<typeof agentSockets>[0], 'io'>): Promise<{ io: SocketServer; url: string; close(): Promise<void> }> {
  const server = http.createServer();
  const io = new SocketServer(server);
  wireSockets(agentSockets({ io, ...given }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    io,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await io.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export function closedAfterEach(): Array<() => Promise<void> | void> {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
  return closers;
}

export async function connectedSocket(url: string, closers: Array<() => Promise<void> | void>, auth?: Record<string, unknown>): Promise<Socket> {
  const socket = connect(url, { ...(auth ? { auth } : {}), transports: ['websocket'], reconnection: false, forceNew: true });
  closers.push(async () => { socket.close(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
  return socket;
}

export async function until<T>(look: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 20));
  }
}

export function quietAccountSides(rootUrl = 'http://root.test'): Pick<MachineAccountsDeps, 'settings' | 'mesh' | 'koala' | 'followers' | 'toOwner' | 'toMachines'> {
  return {
    settings: { url: rootUrl, meshLoginServer: 'https://mesh.test' },
    mesh: { createPreAuthKey: async () => ({ key: 'hskey' }), removeNode: async () => undefined },
    koala: { of: async () => undefined },
    followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: { removed: () => false, koala: () => false, online: () => false },
  };
}

export function onlineMachines(store: MachineDeps['store'], over: Pick<MachineDeps, 'bundle' | 'clusters'> = {}): MachineService {
  return new MachineService({
    store,
    devices: { status: () => ({ online: true }) } as never,
    accounts: { createJoinCode: async () => { throw new Error('not used'); }, remove: async () => false },
    projects: { register: async () => { throw new Error('not used'); } },
    ...over,
  });
}
