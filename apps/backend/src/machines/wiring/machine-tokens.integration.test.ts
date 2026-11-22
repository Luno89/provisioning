import { testKeys } from '../../platform/testing/keys.js';
import http from 'node:http';
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { Watching } from '../../platform/lib/change-streams.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { machineClientsAt, machineSignInKey, machineTokenAt } from '../../instances/testing/registration-code.js';
import { deviceTokenHash } from '../lib/device-tokens.js';
import { issueWorkToken, WORK_TOKEN_REFUSED, WORK_TOKEN_TTL_SECONDS } from '../lib/work-tokens.js';
import { MACHINE_CLIENT_TOKEN, MACHINE_KEY_REPLACE, WORK_TOKEN_ENDED } from '@koala/engine-core/machine-join';
import { keyReplacementFrom } from '@koala/engine-core/root-client';
import { dropDevice, localAgentStatus } from '../lib/local-agent-registry.js';
import { MachineAccounts, type MachineMessages } from '../services/MachineAccounts.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { MachineService } from '../services/MachineService.js';
import { MachineTemporalGateway } from '../services/MachineTemporalGateway.js';
import { wireMachineAccounts } from './accounts.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';
import { deviceByWorkToken } from './machines.js';
import { wireSockets } from './sockets.js';
import { agentSockets, hearing, until } from '../testing/wiring-world.js';

const fresh = await emptiedEachTime();

const DAY = 24 * 60 * 60 * 1000;
const ISSUED = new Date(Date.now() - 65 * DAY);
const OLD_TOKEN = 'the-token-the-machine-joined-with-0123456789';
const POLL_PATH = '/temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue';

const keys = testKeys('machine-tokens-test-secret');
const root = identityKeysFrom(generateIdentityKey());
const otherRoot = identityKeysFrom(generateIdentityKey());
const trust = { keys: trustedKeys([publicKeyPem(root.publicKey)]), audience: 'inst-1' };

let db: MongoDB;
let clock: Date;
let accounts: MachineAccounts;
let machines: MachineService;
let server: http.Server;
let io: SocketServer;
let watching: () => Watching;
let url = '';

const accountsOn = (store: MongoDB['machines'], toMachines: MachineMessages): MachineAccounts => new MachineAccounts({
  store,
  signing: root,
  clients: machineClientsAt(db),
  settings: { url: 'http://root.test' },
  koala: { of: async () => ({ url: 'http://inst.test', audience: 'inst-1' }) },
  followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
  toOwner: { machinesChanged: () => undefined },
  toMachines,
  now: () => clock,
});
let gateway: MachineTemporalGateway;
let gatewayAddress = '';
const TLS_DIR = path.dirname(inject('temporalCa'));
let temporal: http2.Http2Server;
const clients: ClientSocket[] = [];

const device = (lifetime: { issuedAt: Date; expiresAt: Date }) => ({
  id: 'desk',
  ownerId: 'owner-1',
  name: 'desk',
  rootDir: '/home/person/koala',
  createdAt: lifetime.issuedAt.toISOString(),
  tokenHash: deviceTokenHash(OLD_TOKEN),
  issuedAt: lifetime.issuedAt.toISOString(),
  expiresAt: lifetime.expiresAt.toISOString(),
  signIn: machineSignInKey(),
});
const keyToken = (lifetime?: { seconds: number }) => machineTokenAt(db, 'desk', lifetime);

const seconds = () => Math.floor(clock.getTime() / 1000);
const workToken = (over: { by?: typeof root; audience?: string; machineId?: string; at?: number } = {}) =>
  issueWorkToken(over.by ?? root, { machineId: over.machineId ?? 'desk', ownerId: 'owner-1', audience: over.audience ?? 'inst-1' }, over.at ?? seconds());

function connectTo(namespace: string, token: string): Promise<{ socket: ClientSocket; error?: string }> {
  const socket = connect(`${url}${namespace}`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ socket }));
    socket.once('connect_error', (err: Error) => resolve({ socket, error: err.message }));
  });
}
const account = (token: string) => connectTo('/machine-account', token);
const work = (token: string) => connectTo('/agent', token);

const cutOrStill = (socket: ClientSocket, answered: () => Promise<void>) => {
  const cut = new Promise<string>((done) => socket.once('disconnect', (reason) => done(reason)));
  return () => Promise.race([cut, answered().then(() => 'still connected: Koala answered the machine after it should have been cut off')]);
};

function gatewayAnswer(token: string): Promise<string | undefined> {
  const session = http2.connect(`https://${gatewayAddress}`, { ca: readFileSync(path.join(TLS_DIR, 'ca.crt')), servername: 'temporal' });
  return new Promise((resolve) => {
    const stream = session.request({ ':method': 'POST', ':path': POLL_PATH, 'content-type': 'application/grpc', authorization: `Bearer ${token}` });
    const settle = (headers: http2.IncomingHttpHeaders) => {
      if (headers['grpc-status'] === undefined) return;
      resolve(String(headers['grpc-message'] ?? headers['grpc-status']));
      session.close();
    };
    stream.on('response', settle);
    stream.on('trailers', settle);
    stream.on('error', () => { resolve(undefined); session.close(); });
    stream.resume();
    stream.end();
  });
}

const git = () => new MachineGitService({
  deviceFor: deviceByWorkToken(db, trust, () => clock),
  remote: async () => undefined,
});

const gitAnswer = async (token: string) => (await git().serve({ token, repo: 'nowhere', route: 'info/refs', service: 'git-upload-pack' } as never)).status;

beforeEach(async () => {
  db = await fresh();
  clock = new Date(ISSUED.getTime() + 65 * DAY);
  const forgotten = { listener: (_deviceId: string) => undefined as void };
  machines = new MachineService({
    store: db.machines,
    devices: { status: () => ({ online: false }), tell: () => false, ask: async () => undefined as never, drop: dropDevice },
    projects: { register: async () => { throw new Error('not used'); }, removeFor: async () => undefined },
    accounts: { createJoinCode: async () => { throw new Error('not used'); }, remove: async () => false },
    now: () => clock,
  });
  machines.onForgotten((deviceId) => forgotten.listener(deviceId));
  server = http.createServer();
  io = new SocketServer(server);
  let sockets: ReturnType<typeof wireMachineAccounts> = { watched: { ready: Promise.resolve(), close: async () => undefined }, removed: () => false, koala: () => false, placeKoala: async () => false, stopKoala: () => false, online: () => false };
  watching = () => sockets.watched;
  accounts = accountsOn(db.machines, { removed: (deviceId) => sockets.removed(deviceId), koala: (deviceId, koala) => sockets.koala(deviceId, koala) });
  sockets = wireMachineAccounts({ io, db, clients: machineClientsAt(db), accounts: () => accounts, installs: () => ({ connected: async () => undefined }), dependencies: new DependencyStates({ process: 'backend', described: ['mongo', 'temporal'] }), now: () => clock });
  wireSockets(agentSockets({ io, db, payloadKey: keys.payload, dataKey: keys.data, machines, workTokens: trust, now: () => clock }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  temporal = http2.createServer();
  temporal.on('stream', (stream) => {
    stream.on('data', () => undefined);
    stream.on('end', () => stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0', 'grpc-message': 'answered by Temporal' }, { endStream: true }));
  });
  await new Promise<void>((done) => temporal.listen(0, '127.0.0.1', done));
  gateway = new MachineTemporalGateway({
    upstream: `127.0.0.1:${(temporal.address() as AddressInfo).port}`,
    upstreamKey: () => 'the-gateway-token',
    namespace: 'default',
    tls: { cert: readFileSync(path.join(TLS_DIR, 'server.crt')), key: readFileSync(path.join(TLS_DIR, 'server.key')) },
    keys: () => ['the-key'],
    deviceOf: deviceByWorkToken(db, trust, () => clock),
    handed: async () => undefined,
  });
  forgotten.listener = (deviceId) => gateway.forget(deviceId);
  gatewayAddress = `127.0.0.1:${await gateway.listen(0, '127.0.0.1')}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await watching().close();
  await io.close();
  await new Promise<void>((done) => server.close(() => done()));
  await gateway.close();
  await new Promise<void>((done) => temporal.close(() => done()));
});

describe('a machine\'s connection to root, on tokens of its own key', () => {
  const askedKoala = (socket: ClientSocket) => () => new Promise<void>((done) => { socket.once('machine:koala', () => done()); socket.emit('machine:koala?'); });

  it('lets the machine in with a token of its key, and refuses none, the account token its join gave and a token of a key it no longer holds', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const replaced = await keyToken();
    expect((await account(replaced)).error).toBeUndefined();
    expect((await account('')).error).toBe('Unauthorized: send a token of this machine\'s key');
    expect((await account(OLD_TOKEN)).error).toBe('Unauthorized');
    await db.machines.updateLocalAgentDevice('desk', { set: { signIn: machineSignInKey() } });
    expect((await account(replaced)).error).toBe('Unauthorized');
    expect((await account(await keyToken())).error).toBeUndefined();
  });

  const connectedWithKey = async (): Promise<ClientSocket> => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const { socket, error } = await account(await keyToken());
    expect(error).toBeUndefined();
    await new Promise((done) => socket.once('machine:koala', done));
    return socket;
  };

  it('closes the machine\'s connection at the first thing it sends once the token it connected with has run out', async () => {
    const socket = await connectedWithKey();
    const cut = cutOrStill(socket, askedKoala(socket));
    clock = new Date(Date.now() + DAY);
    expect(await cut()).toBe('io server disconnect');
  });

  it('keeps the machine\'s connection past that once the machine sent a fresh token of its key first', async () => {
    const socket = await connectedWithKey();
    clock = new Date(Date.now() + DAY);
    socket.emit(MACHINE_CLIENT_TOKEN, { token: await keyToken({ seconds: 2 * 24 * 3600 }) });
    const answered = new Promise<string>((done) => {
      socket.once('machine:koala', () => done('answered'));
      socket.once('disconnect', (reason) => done(`cut: ${reason}`));
    });
    socket.emit('machine:koala?');
    expect(await answered).toBe('answered');
  });

  it('cuts the machine\'s connection when the fresh token it sends is not one of its key', async () => {
    const socket = await connectedWithKey();
    const cut = cutOrStill(socket, askedKoala(socket));
    socket.emit(MACHINE_CLIENT_TOKEN, { token: OLD_TOKEN });
    expect(await cut()).toBe('io server disconnect');
  });

  it('hands the machine its Koala and a work token on connecting, and again when it asks', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const socket = connect(`${url}/machine-account`, { auth: { token: await keyToken() }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    const told = hearing<{ url: string; workToken: string } | null>(socket, 'machine:koala');
    const [first] = await told.saidTimes(1);
    expect(first?.url).toBe('http://inst.test');
    expect((await work(first!.workToken)).error).toBeUndefined();
    socket.emit('machine:koala?');
    const again = await told.saidTimes(2);
    expect(again).toHaveLength(2);
    expect(again[1]?.url).toBe('http://inst.test');
  });

  const firstWord = async (answer: { replaced: boolean; problem?: string }) => {
    const socket = connect(`${url}/machine-account`, { auth: { token: await keyToken() }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    let told = 0;
    const toldTwice = new Promise<void>((done) => socket.on('machine:koala', () => { told += 1; if (told === 2) done(); }));
    const heard = await new Promise<{ offer?: unknown; koala?: true }>((done) => {
      socket.once(MACHINE_KEY_REPLACE, (offer: unknown, ack: (answer: unknown) => void) => {
        ack(answer);
        socket.emit('machine:koala?');
        done({ offer });
      });
      socket.once('machine:koala', () => done({ koala: true }));
    });
    return { socket, heard, answeredAfter: () => toldTwice };
  };
  const keyOf = async () => (await db.machines.getLocalAgentDevices())[0];

  it('offers a machine whose key nears the end of its 90 days a one-use replacement as it connects, before anything else, and records why when the machine could not take it', async () => {
    await db.machines.saveLocalAgentDevice({ ...device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }), signIn: { ...machineSignInKey(), since: ISSUED.toISOString() } });
    const refused = await firstWord({ replaced: false, problem: 'the disk was full' });
    expect(keyReplacementFrom(refused.heard.offer)).toMatchObject({ registrationClientUri: 'http://127.0.0.1:1/oidc/reg/desk' });
    await refused.answeredAfter();
    expect((await keyOf())?.keyReplacement).toEqual({ reason: 'the disk was full', failedAt: clock.toISOString() });
    const taken = await firstWord({ replaced: true });
    expect(keyReplacementFrom(taken.heard.offer)).toBeDefined();
    await taken.answeredAfter();
    expect((await keyOf())?.keyReplacement).toBeUndefined();
  });

  it('offers no replacement to a machine whose key has more than 30 days left', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    expect((await firstWord({ replaced: true })).heard).toEqual({ koala: true });
  });

  it('is cut off at root the moment the person removes the machine, after it is told why', async () => {
    const socket = await connectedWithKey();
    const token = await keyToken();
    const heard: string[] = [];
    socket.on('machine:removed', () => heard.push('removed'));
    const cut = cutOrStill(socket, askedKoala(socket));
    expect(await accounts.remove('owner-1', 'desk')).toBe(true);
    expect(await cut()).toBe('io server disconnect');
    expect(heard).toEqual(['removed']);
    expect((await account(token)).error).toBe('Unauthorized');
  });
});

describe('a machine\'s work token at its Koala', () => {
  it('lets the machine in at the socket, the git proxy and the gateway', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const token = workToken();
    expect((await work(token)).error).toBeUndefined();
    expect(await gitAnswer(token)).not.toBe(401);
    expect(await gatewayAnswer(token)).not.toMatch(/not known here/);
  });

  it('is refused for another Koala, from another root, past its expiry, and for a machine this Koala does not have', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    for (const [token, said] of [
      [workToken({ audience: 'inst-2' }), WORK_TOKEN_REFUSED['wrong-audience']],
      [workToken({ by: otherRoot }), WORK_TOKEN_REFUSED['unknown-key']],
      [workToken({ at: seconds() - WORK_TOKEN_TTL_SECONDS - 1 }), WORK_TOKEN_REFUSED.expired],
      [OLD_TOKEN, WORK_TOKEN_REFUSED.malformed],
      [workToken({ machineId: 'other' }), 'this machine is not one of this Koala\'s: run the command from My Machines again'],
    ] as const) {
      expect((await work(token)).error).toBe(said);
      expect(await gitAnswer(token)).toBe(401);
      expect(await gatewayAnswer(token)).toMatch(/not known here/);
    }
  });

  it('stops working at the gateway the moment the machine leaves, though the gateway had just let it in', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const token = workToken();
    expect(await gatewayAnswer(token)).not.toMatch(/not known here/);
    await db.machines.deleteLocalAgentDevice('desk');
    await machines.forget({ id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/x', createdAt: 'then' });
    expect(await gatewayAnswer(token)).toMatch(/not known here/);
    expect(await gitAnswer(token)).toBe(401);
  });

  it('closes the machine\'s connection the moment its Koala forgets the machine root removed', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const { socket, error } = await work(workToken());
    expect(error).toBeUndefined();
    const cut = cutOrStill(socket, () => socket.emitWithAck('agents:manual', {}).then(() => undefined));
    await until(async () => (localAgentStatus('desk').online ? true : undefined));
    await db.machines.deleteLocalAgentDevice('desk');
    await machines.forget({ id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/x', createdAt: 'then' });
    expect(await cut()).toBe('io server disconnect');
  });

  it('closes the machine\'s connection at the first thing it sends once its work token has run out, saying why', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const { socket, error } = await work(workToken());
    expect(error).toBeUndefined();
    const told: string[] = [];
    socket.on(WORK_TOKEN_ENDED, ({ said }: { said: string }) => told.push(said));
    const cut = cutOrStill(socket, () => socket.emitWithAck('agents:manual', {}).then(() => undefined));
    clock = new Date(clock.getTime() + (WORK_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(await cut()).toBe('io server disconnect');
    expect(told).toEqual([WORK_TOKEN_REFUSED.expired]);
  });
});
