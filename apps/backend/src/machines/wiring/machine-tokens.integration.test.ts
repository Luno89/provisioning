import { testKeys } from '../../platform/testing/keys.js';
import crypto from 'node:crypto';
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
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { machineAccessAt, machineAccessCheckedAt, machineAccessCheckedByServedRoot, machineClientsAt, machineSignInKey, machineTokenAt } from '../../instances/testing/registration-code.js';
import { runResourceOf } from '../../instances/lib/oidc.js';
import { temporal as proto } from '@temporalio/proto';
import { deviceQueueOf, frame } from '../lib/temporal-gateway.js';
import { MACHINE_CLIENT_TOKEN, MACHINE_KEY_REPLACE } from '@koala/engine-core/machine-join';
import { keyReplacementFrom } from '@koala/engine-core/root-client';
import { dropDevice, localAgentStatus } from '../lib/local-agent-registry.js';
import { MachineAccounts, type MachineMessages } from '../services/MachineAccounts.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { MachineService } from '../services/MachineService.js';
import { MachineTemporalGateway } from '../services/MachineTemporalGateway.js';
import { wireMachineAccounts } from './accounts.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';
import { deviceByMachineToken, machineAdmission } from './machine-admission.js';
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
const ROOT_URL = 'http://127.0.0.1:1';

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
let rootAway = false;
const TLS_DIR = path.dirname(inject('temporalCa'));
let temporal: http2.Http2Server;
const clients: ClientSocket[] = [];

const device = (lifetime: { issuedAt: Date; expiresAt: Date }) => ({
  id: 'desk',
  ownerId: 'owner-1',
  name: 'desk',
  rootDir: '/home/person/koala',
  createdAt: lifetime.issuedAt.toISOString(),
  signIn: machineSignInKey(),
});
const keyToken = (lifetime?: { seconds: number }) => machineTokenAt(db, 'desk', lifetime);
const access = (over: { deviceId?: string; koala?: string; by?: typeof root; seconds?: number } = {}) =>
  machineAccessAt(db, { url: ROOT_URL, signing: over.by ?? root }, { deviceId: over.deviceId ?? 'desk', koala: over.koala ?? 'inst-1' }, over.seconds ? { seconds: over.seconds } : undefined);
const koalaOf = (id: string, ownerId: string) => db.instances.saveInstance({ id, ownerId, url: `http://${id}.test`, createdAt: 'then', updatedAt: 'then', status: 'ready' });

const seconds = () => Math.floor(clock.getTime() / 1000);
const oldWorkToken = () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${part({ alg: 'EdDSA', typ: 'nowrinkles-machine', kid: root.kid })}.${part({ sub: 'desk', owner: 'owner-1', aud: 'inst-1', iat: seconds(), exp: seconds() + 30 * 24 * 3600 })}`;
  return `${signed}.${crypto.sign(null, Buffer.from(signed), root.privateKey).toString('base64url')}`;
};

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

const pollOf = (queue: string) => frame(Buffer.from(proto.api.workflowservice.v1.PollActivityTaskQueueRequest.encode({ namespace: 'default', taskQueue: { name: queue }, identity: 'desk' }).finish()));
const gatewaySessions: http2.ClientHttp2Session[] = [];

function gatewayConnection() {
  const session = http2.connect(`https://${gatewayAddress}`, { ca: readFileSync(path.join(TLS_DIR, 'ca.crt')), servername: 'temporal' });
  gatewaySessions.push(session);
  session.on('error', () => undefined);
  const ended = new Promise<string>((done) => session.once('close', () => done('cut')));
  const poll = (token: string, queue = deviceQueueOf('desk'), withStatus = false): Promise<string> => new Promise((resolve) => {
    if (session.closed || session.destroyed) return resolve('cut');
    const stream = session.request({ ':method': 'POST', ':path': POLL_PATH, 'content-type': 'application/grpc', authorization: `Bearer ${token}` });
    const settle = (headers: http2.IncomingHttpHeaders) => {
      if (headers['grpc-status'] === undefined) return;
      const said = String(headers['grpc-message'] ?? headers['grpc-status']);
      resolve(withStatus ? `${String(headers['grpc-status'])}: ${decodeURIComponent(said)}` : said);
    };
    stream.on('response', settle);
    stream.on('trailers', settle);
    stream.on('error', () => resolve('cut'));
    stream.on('close', () => resolve('cut'));
    stream.resume();
    stream.end(pollOf(queue));
  });
  const cutOrAnswered = (token: string) => Promise.race([ended, poll(token).then((answer) => (answer === 'cut' ? 'cut' : `still connected: ${answer}`))]);
  return { poll, cutOrAnswered };
}

const gatewayAnswer = (token: string, queue?: string) => gatewayConnection().poll(token, queue);

const git = () => new MachineGitService({
  deviceFor: deviceByMachineToken(db, machineAccessCheckedAt({ url: ROOT_URL, signing: root }, 'inst-1', () => clock.getTime()), 'owner-1'),
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
  await koalaOf('inst-1', 'owner-1');
  wireSockets(agentSockets({ io, db, payloadKey: keys.payload, dataKey: keys.data, machines, machineTokens: machineAccessCheckedAt({ url: ROOT_URL, signing: root }, 'inst-1', () => clock.getTime()), now: () => clock }));
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
    admit: machineAdmission(db, { checkMachineToken: (token) => (rootAway ? machineAccessCheckedByServedRoot(ROOT_URL, 'inst-1') : machineAccessCheckedAt({ url: ROOT_URL, signing: root }, 'inst-1', () => clock.getTime())).checkMachineToken(token) }, 'owner-1'),
    now: () => clock.getTime(),
    handed: async () => undefined,
  });
  forgotten.listener = (deviceId) => gateway.forget(deviceId);
  gatewayAddress = `127.0.0.1:${await gateway.listen(0, '127.0.0.1')}`;
});

afterEach(async () => {
  rootAway = false;
  for (const client of clients.splice(0)) client.close();
  for (const session of gatewaySessions.splice(0)) session.destroy();
  await watching().close();
  await io.close();
  await new Promise<void>((done) => server.close(() => done()));
  await gateway.close();
  await new Promise<void>((done) => temporal.close(() => done()));
});

describe('a machine\'s connection to root, on tokens of its own key', () => {
  const askedKoala = (socket: ClientSocket) => () => new Promise<void>((done) => { socket.once('machine:koala', () => done()); socket.emit('machine:koala?'); });

  it('lets the machine in with a token of its key, and refuses none, a token that is not of its key and a token of a key it no longer holds', async () => {
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

  it('hands the machine its Koala and the resource root gives it tokens for there, and nothing else, on connecting, and again when it asks', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const socket = connect(`${url}/machine-account`, { auth: { token: await keyToken() }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    const told = hearing<{ url: string; resource: string } | null>(socket, 'machine:koala');
    const [first] = await told.saidTimes(1);
    expect(first).toEqual({ url: 'http://inst.test', resource: runResourceOf('inst-1') });
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

describe('a machine\'s token from root for its Koala, at the Koala\'s socket', () => {
  const saveDesk = () => db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
  const answeredOrCut = (socket: ClientSocket) => new Promise<string>((done) => {
    socket.once('disconnect', (reason) => done(`cut: ${reason}`));
    socket.emitWithAck('agents:manual', {}).then(() => done('answered'), (err: Error) => done(`cut: ${err.message}`));
  });

  it('lets the machine in with a token root gave it for this Koala, and refuses none, one for another Koala, one another key signed, one that ran out, and one of a machine this Koala does not have', async () => {
    await saveDesk();
    expect((await work(await access())).error).toBeUndefined();
    expect((await work('')).error).toBe('Unauthorized: send a token root gave this machine for this Koala');
    await koalaOf('inst-2', 'owner-2');
    await db.machines.saveLocalAgentDevice({ ...device({ issuedAt: ISSUED, expiresAt: ISSUED }), id: 'lap', ownerId: 'owner-2' });
    expect((await work(await access({ deviceId: 'lap', koala: 'inst-2' }))).error).toMatch(/^Unauthorized: the machine's token could not be checked: .*aud/);
    expect((await work(await access({ by: otherRoot }))).error).toMatch(/^Unauthorized: the machine's token could not be checked/);
    const short = await access({ seconds: 60 });
    clock = new Date(clock.getTime() + 2 * 60 * 1000);
    expect((await work(short)).error).toMatch(/^Unauthorized: the machine's token could not be checked: .*exp/);
    const gone = await access();
    await db.machines.deleteLocalAgentDevice('desk');
    expect((await work(gone)).error).toBe('this machine is not one of this Koala\'s: run the command from My Machines again');
  });

  it('closes the machine\'s connection at the first thing it sends once its token has run out', async () => {
    await saveDesk();
    const { socket, error } = await work(await access({ seconds: 60 }));
    expect(error).toBeUndefined();
    expect(await answeredOrCut(socket)).toBe('answered');
    clock = new Date(clock.getTime() + 2 * 60 * 1000);
    expect(await answeredOrCut(socket)).toBe('cut: io server disconnect');
  });

  it('keeps the machine\'s connection past that once the machine sent a fresh token of its own first, until that one runs out too', async () => {
    await saveDesk();
    const { socket, error } = await work(await access({ seconds: 60 }));
    expect(error).toBeUndefined();
    socket.emit(MACHINE_CLIENT_TOKEN, { token: await access({ seconds: 600 }) });
    clock = new Date(clock.getTime() + 2 * 60 * 1000);
    expect(await answeredOrCut(socket)).toBe('answered');
    clock = new Date(clock.getTime() + 10 * 60 * 1000);
    expect(await answeredOrCut(socket)).toBe('cut: io server disconnect');
  });

  it('cuts the machine\'s connection when the fresh token it sends is another machine\'s or not root\'s', async () => {
    await saveDesk();
    await db.machines.saveLocalAgentDevice({ ...device({ issuedAt: ISSUED, expiresAt: ISSUED }), id: 'other' });
    for (const fresh of [await access({ deviceId: 'other' }), await access({ by: otherRoot })]) {
      const { socket, error } = await work(await access());
      expect(error).toBeUndefined();
      socket.emit(MACHINE_CLIENT_TOKEN, { token: fresh });
      expect(await answeredOrCut(socket)).toBe('cut: io server disconnect');
    }
  });
});

describe('a machine\'s token from root for its Koala, at the Koala\'s git', () => {
  it('lets the machine fetch and push with a token root gave it for this Koala, and refuses one for another Koala, one that ran out, one another key signed, its work token, and one of a machine this Koala does not have', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    expect(await gitAnswer(await access())).toBe(404);
    await koalaOf('inst-2', 'owner-2');
    await db.machines.saveLocalAgentDevice({ ...device({ issuedAt: ISSUED, expiresAt: ISSUED }), id: 'lap', ownerId: 'owner-2' });
    expect(await gitAnswer(await access({ deviceId: 'lap', koala: 'inst-2' }))).toBe(401);
    expect(await gitAnswer(await access({ by: otherRoot }))).toBe(401);
    expect(await gitAnswer(oldWorkToken())).toBe(401);
    const short = await access({ seconds: 60 });
    expect(await gitAnswer(short)).toBe(404);
    clock = new Date(clock.getTime() + 2 * 60 * 1000);
    expect(await gitAnswer(short)).toBe(401);
    const gone = await access();
    await db.machines.deleteLocalAgentDevice('desk');
    expect(await gitAnswer(gone)).toBe(401);
  });
});

describe('a machine\'s token from root for its Koala, at the gateway to its Koala\'s Temporal', () => {
  const saveDesk = () => db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));

  it('serves the machine its own queue on a token root gave it for this Koala, and no other machine\'s queue', async () => {
    await saveDesk();
    expect(await gatewayAnswer(await access())).toBe('answered by Temporal');
    expect(await gatewayAnswer(await access(), deviceQueueOf('other'))).toBe('a machine takes work only from its own queue, device-desk');
  });

  it('answers a poll as unavailable while root\'s keys cannot be fetched, never as unauthenticated, and lets the same token in once root is back', async () => {
    await saveDesk();
    const token = await access();
    rootAway = true;
    expect(await gatewayConnection().poll(token, undefined, true)).toMatch(/^14: the machine's token could not be checked just now: /);
    rootAway = false;
    expect(await gatewayAnswer(token)).toBe('answered by Temporal');
  });

  it('refuses none, one for another Koala, one another key signed, one that ran out, the old work token, and one of a machine this Koala does not have', async () => {
    await saveDesk();
    await koalaOf('inst-2', 'owner-2');
    await db.machines.saveLocalAgentDevice({ ...device({ issuedAt: ISSUED, expiresAt: ISSUED }), id: 'lap', ownerId: 'owner-2' });
    expect(await gatewayAnswer('')).toBe('Unauthorized: send a token root gave this machine for this Koala');
    expect(await gatewayAnswer(await access({ deviceId: 'lap', koala: 'inst-2' }))).toMatch(/^Unauthorized: the machine's token could not be checked: .*aud/);
    expect(await gatewayAnswer(await access({ by: otherRoot }))).toMatch(/^Unauthorized: the machine's token could not be checked/);
    const short = await access({ seconds: 60 });
    const old = oldWorkToken();
    const gone = await access();
    clock = new Date(clock.getTime() + 2 * 60 * 1000);
    expect(await gatewayAnswer(short)).toMatch(/^Unauthorized: the machine's token could not be checked: .*exp/);
    expect(await gatewayAnswer(old)).toMatch(/^Unauthorized: the machine's token could not be checked/);
    expect(await gatewayAnswer(OLD_TOKEN)).toMatch(/^Unauthorized: the machine's token could not be checked/);
    await db.machines.deleteLocalAgentDevice('desk');
    expect(await gatewayAnswer(gone)).toBe('this machine is not one of this Koala\'s: run the command from My Machines again');
  });

  it('cuts the machine\'s connection at its first call once its token has run out', async () => {
    await saveDesk();
    const token = await access({ seconds: 60 });
    const connection = gatewayConnection();
    expect(await connection.poll(token)).toBe('answered by Temporal');
    clock = new Date(clock.getTime() + 2 * 60 * 1000);
    expect(await connection.poll(token)).toBe('Unauthorized: this machine\'s token from root ended; it takes a fresh one and connects again');
    expect(await connection.cutOrAnswered(await access({ seconds: 600 }))).toBe('cut');
  });

  it('keeps the machine\'s connection past that once its next call carries a fresh token of its own, until that one runs out too', async () => {
    await saveDesk();
    const connection = gatewayConnection();
    expect(await connection.poll(await access({ seconds: 60 }))).toBe('answered by Temporal');
    const fresh = await access({ seconds: 600 });
    clock = new Date(clock.getTime() + 2 * 60 * 1000);
    expect(await connection.poll(fresh)).toBe('answered by Temporal');
    clock = new Date(clock.getTime() + 10 * 60 * 1000);
    expect(await connection.poll(fresh)).toMatch(/^Unauthorized: /);
    expect(await connection.cutOrAnswered(await access({ seconds: 6000 }))).toBe('cut');
  });

  it('cuts the machine\'s connection when its next call carries another machine\'s token', async () => {
    await saveDesk();
    await db.machines.saveLocalAgentDevice({ ...device({ issuedAt: ISSUED, expiresAt: ISSUED }), id: 'other' });
    const connection = gatewayConnection();
    expect(await connection.poll(await access())).toBe('answered by Temporal');
    expect(await connection.poll(await access({ deviceId: 'other' }))).toMatch(/^Unauthorized: /);
    expect(await connection.cutOrAnswered(await access())).toBe('cut');
  });

  it('cuts the machine\'s connection the moment the machine leaves, and lets it in no more', async () => {
    await saveDesk();
    const token = await access();
    const connection = gatewayConnection();
    expect(await connection.poll(token)).toBe('answered by Temporal');
    await db.machines.deleteLocalAgentDevice('desk');
    await machines.forget({ id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/x', createdAt: 'then' });
    expect(await connection.cutOrAnswered(token)).toBe('cut');
    expect(await gatewayAnswer(token)).toBe('this machine is not one of this Koala\'s: run the command from My Machines again');
  });
});

describe('a machine root removed, at its Koala', () => {
  it('closes the machine\'s connection the moment its Koala forgets the machine root removed', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const { socket, error } = await work(await access());
    expect(error).toBeUndefined();
    const cut = cutOrStill(socket, () => socket.emitWithAck('agents:manual', {}).then(() => undefined));
    await until(async () => (localAgentStatus('desk').online ? true : undefined));
    await db.machines.deleteLocalAgentDevice('desk');
    await machines.forget({ id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/x', createdAt: 'then' });
    expect(await cut()).toBe('io server disconnect');
  });
});
