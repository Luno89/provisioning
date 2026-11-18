import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server as SocketServer } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkToRoot, type RootLink } from '../../../../local-agent/src/root-link.js';
import { placedFrom, type PlacedKoala } from '../../../../local-agent/src/koala-install.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { InstanceService, hashCredential, instanceIdFor } from '../../instances/services/InstanceService.js';
import { deviceTokenHash } from '../lib/device-tokens.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { wireMachineAccounts } from './accounts.js';

const fresh = await emptiedEachTime();
const TOKEN = 'the-desk-token-0123456789-0123456789';

let db: MongoDB;
let server: http.Server;
let url = '';
let accounts: MachineAccounts;
let folder = '';
const links: RootLink[] = [];

async function until<T>(look: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 20));
  }
}

beforeEach(async () => {
  db = await fresh();
  folder = await mkdtemp(path.join(tmpdir(), 'koala-placement-'));
  const instances = new InstanceService(db, {
    rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
  }, { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined });
  server = http.createServer();
  const io = new SocketServer(server);
  let sockets: ReturnType<typeof wireMachineAccounts> | undefined;
  accounts = new MachineAccounts({
    store: db.machines,
    signing: identityKeysFrom(generateIdentityKey()),
    settings: { url: 'http://root.test' },
    koala: { of: async () => undefined },
    followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: { removed: (id) => sockets!.removed(id), koala: (id, koala) => sockets!.koala(id, koala), placeKoala: (id, placed) => sockets!.placeKoala(id, placed), online: (id) => sockets!.online(id) },
    placer: instances,
  });
  sockets = wireMachineAccounts({ io, db, accounts: () => accounts });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-11-05T00:00:00Z', tokenHash: deviceTokenHash(TOKEN), koalaWanted: { name: 'bobby' } });
});

afterEach(async () => {
  for (const link of links.splice(0)) link.close();
  await new Promise<void>((done) => { server.close(() => done()); });
  await rm(folder, { recursive: true, force: true });
});

const agent = (onPlaceKoala: (raw: unknown) => boolean) => {
  const link = linkToRoot({
    rootUrl: url, token: TOKEN, configFile: path.join(folder, 'machine.json'), meshIp: async () => '100.64.0.7',
    onKoala: () => undefined, onRemoved: () => undefined, onPlaceKoala, say: () => undefined,
  });
  links.push(link);
  return link;
};

describe('Koala put on a machine through its link to root', () => {
  it('is handed to the machine the moment it connects on the mesh, as the instance root made for it, and the wish is spent', async () => {
    const handed: PlacedKoala[] = [];
    agent((raw) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); });
    const placed = await until(async () => handed[0]);
    expect(placed).toMatchObject({ instanceId: instanceIdFor('bo'), machineId: 'desk', meshAddress: '100.64.0.7', name: 'bobby', image: '100.64.0.1:5001/nowrinkles/app' });
    const instance = (await db.instances.getInstances('bo'))[0];
    expect(instance).toMatchObject({ status: 'joined', machineId: 'desk', credentialHash: hashCredential(placed.credential) });
    await until(async () => ((await db.machines.getLocalAgentDevices())[0]?.koalaWanted ? undefined : true));
    expect((await accounts.listOnline('bo'))[0]).toMatchObject({ online: true, koalaWanted: false });
  });

  it('keeps the wish when the machine does not take it, so it is handed again on the next connection', async () => {
    let refused = 0;
    agent(() => { refused += 1; return false; });
    await until(async () => (refused ? true : undefined));
    expect((await db.machines.getLocalAgentDevices())[0]?.koalaWanted).toEqual({ name: 'bobby' });
  });
});
