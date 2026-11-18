import { testKeys } from '../../platform/testing/keys.js';
import http from 'node:http';
import http2 from 'node:http2';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveDeviceToken, tokenAnswer } from '../../../../local-agent/src/machine-token.js';
import { emptiedEachTime, testPayloadBlobs } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { deviceTokenHash, TOKEN_EXPIRED_SAID } from '../lib/device-tokens.js';
import { issueWorkToken, WORK_TOKEN_REFUSED, WORK_TOKEN_TTL_SECONDS } from '../lib/work-tokens.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { MachineService } from '../services/MachineService.js';
import { MachineTemporalGateway } from '../services/MachineTemporalGateway.js';
import { wireMachineAccounts } from './accounts.js';
import { deviceByWorkToken } from './machines.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';

const fresh = await emptiedEachTime();

const DAY = 24 * 60 * 60 * 1000;
const ISSUED = new Date('2026-10-10T00:00:00Z');
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
let url = '';
let gateway: MachineTemporalGateway;
let gatewayAddress = '';
let temporal: http2.Http2Server;
let folder = '';
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
});

const seconds = () => Math.floor(clock.getTime() / 1000);
const workToken = (over: { by?: typeof root; audience?: string; machineId?: string; at?: number } = {}) =>
  issueWorkToken(over.by ?? root, { machineId: over.machineId ?? 'desk', ownerId: 'owner-1', audience: over.audience ?? 'inst-1' }, over.at ?? seconds());

function connectTo(namespace: string, token: string, onToken?: (token: string, ack: (answer: { taken: boolean }) => void) => void): Promise<{ socket: ClientSocket; error?: string }> {
  const socket = connect(`${url}${namespace}`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  if (onToken) socket.on('machine:token', ({ token: next }: { token: string }, ack: (answer: { taken: boolean }) => void) => onToken(next, ack));
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ socket }));
    socket.once('connect_error', (err: Error) => resolve({ socket, error: err.message }));
  });
}
const account = (token: string, onToken?: (token: string, ack: (answer: { taken: boolean }) => void) => void) => connectTo('/machine-account', token, onToken);
const work = (token: string) => connectTo('/agent', token);

async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
}

const stored = async () => (await db.machines.getLocalAgentDevices()).find((one) => one.id === 'desk')!;

function gatewayAnswer(token: string): Promise<string | undefined> {
  const session = http2.connect(`http://${gatewayAddress}`);
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
  folder = await mkdtemp(path.join(tmpdir(), 'koala-machine-'));
  const forgotten = { listener: (_deviceId: string) => undefined as void };
  machines = new MachineService({
    store: db.machines,
    devices: { status: () => ({ online: false }), tell: () => false, ask: async () => undefined as never, drop: () => undefined },
    projects: { register: async () => { throw new Error('not used'); }, removeFor: async () => undefined },
    accounts: { createJoinCode: async () => { throw new Error('not used'); }, remove: async () => false },
    now: () => clock,
  });
  machines.onForgotten((deviceId) => forgotten.listener(deviceId));
  server = http.createServer();
  io = new SocketServer(server);
  let sockets: ReturnType<typeof wireMachineAccounts> = { removed: () => false, koala: () => false, placeKoala: async () => false, online: () => false };
  accounts = new MachineAccounts({
    store: db.machines,
    signing: root,
    settings: { url: 'http://root.test' },
    koala: { of: async () => ({ url: 'http://inst.test', audience: 'inst-1' }) },
    followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toMachines: { removed: (deviceId) => sockets.removed(deviceId), koala: (deviceId, koala) => sockets.koala(deviceId, koala) },
    now: () => clock,
  });
  sockets = wireMachineAccounts({ io, db, accounts: () => accounts, now: () => clock });
  wireSockets({
    io, db, role: { role: 'instance', instance: { id: 'inst-1', ownerId: 'owner-1', rootUrl: 'http://root.test' } }, payloadBlobs: testPayloadBlobs().blobs, payloadKey: keys.payload, dataKey: keys.data,
    auth: { sessionFromCookie: async () => undefined, securedFor: () => false, principalFor: () => undefined } as unknown as SocketsWiringDeps['auth'],
    sessionSockets: { track: () => undefined, forget: () => undefined },
    machines, workTokens: trust, clusters: {} as never, apps: {} as never,
    telemetry: { relay: async () => ({ ok: true }) } as never,
    now: () => clock,
  });
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
    keys: () => ['the-key'],
    deviceOf: deviceByWorkToken(db, trust, () => clock),
    handed: async () => undefined,
  });
  forgotten.listener = (deviceId) => gateway.forget(deviceId);
  gatewayAddress = `127.0.0.1:${await gateway.listen(0, '127.0.0.1')}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await io.close();
  await new Promise<void>((done) => server.close(() => done()));
  await gateway.close();
  await new Promise<void>((done) => temporal.close(() => done()));
  await rm(folder, { recursive: true, force: true });
});

describe('a machine\'s account token at root, in its last 30 days', () => {
  it('is replaced over root\'s socket, written by the agent, and the old one is refused there', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const file = path.join(folder, 'machine.json');
    let received = '';
    const first = await account(OLD_TOKEN, (next, ack) => {
      received = next;
      void saveDeviceToken(file, next).then(() => ack(tokenAnswer(true)));
    });
    expect(first.error).toBeUndefined();
    await until(async () => ((await stored()).tokenHash === deviceTokenHash(received) && received ? true : undefined));
    const saved = JSON.parse(await readFile(file, 'utf8')) as { token: string };
    expect(saved.token).toBe(received);
    expect(received).not.toBe(OLD_TOKEN);
    const promoted = await stored();
    expect(promoted.nextTokenHash).toBeUndefined();
    expect(Date.parse(promoted.expiresAt!)).toBe(clock.getTime() + 90 * DAY);
    expect((await account(saved.token)).error).toBeUndefined();
    expect((await account(OLD_TOKEN)).error).toBe('Unauthorized');
  });

  it('keeps both tokens working when the agent stops between receiving the new one and saying it took it', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    let received = '';
    const first = await account(OLD_TOKEN, (next) => { received = next; });
    expect(first.error).toBeUndefined();
    await until(async () => (received && (await stored()).nextTokenHash ? true : undefined));
    first.socket.close();
    expect((await account(OLD_TOKEN)).error).toBeUndefined();
    expect((await account(received)).error).toBeUndefined();
    await until(async () => ((await stored()).tokenHash === deviceTokenHash(received) ? true : undefined));
    expect((await account(OLD_TOKEN)).error).toBe('Unauthorized');
  }, 30_000);

  it('is shown on the machine as not renewed, saying why, when the agent could not keep the new one', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const first = await account(OLD_TOKEN, (_next, ack) => ack(tokenAnswer(false)));
    expect(first.error).toBeUndefined();
    const renewal = await until(async () => (await stored()).tokenRenewal);
    expect(renewal).toMatchObject({ reason: 'the machine did not keep its new token' });
    expect((await account(OLD_TOKEN)).error).toBeUndefined();
  });

  it('is refused past its expiry, saying to run the command from My Machines again', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    clock = new Date(ISSUED.getTime() + 91 * DAY);
    expect((await account(OLD_TOKEN)).error).toBe(TOKEN_EXPIRED_SAID);
  }, 30_000);

  it('hands the machine its Koala and a work token on connecting, and again when it asks', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const told: Array<{ url: string; workToken: string } | null> = [];
    const socket = connect(`${url}/machine-account`, { auth: { token: OLD_TOKEN }, transports: ['websocket'], reconnection: false, forceNew: true });
    clients.push(socket);
    socket.on('machine:koala', (koala: { url: string; workToken: string } | null) => told.push(koala));
    await until(async () => (told.length ? true : undefined));
    expect(told[0]?.url).toBe('http://inst.test');
    expect((await work(told[0]!.workToken)).error).toBeUndefined();
    socket.emit('machine:koala?');
    await until(async () => (told.length === 2 ? true : undefined));
  }, 30_000);
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
  }, 30_000);

  it('stops working at the gateway the moment the machine leaves, though the gateway had just let it in', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const token = workToken();
    expect(await gatewayAnswer(token)).not.toMatch(/not known here/);
    await db.machines.deleteLocalAgentDevice('desk');
    await machines.forget({ id: 'desk', ownerId: 'owner-1', name: 'desk', rootDir: '/x', createdAt: 'then' });
    expect(await gatewayAnswer(token)).toMatch(/not known here/);
    expect(await gitAnswer(token)).toBe(401);
  }, 30_000);
});
