import { io as connect, type Socket } from 'socket.io-client';
import { afterEach } from 'vitest';
import type { MachineAccountsDeps } from '../services/MachineAccounts.js';
import { MachineService, type MachineDeps } from '../services/MachineService.js';

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
