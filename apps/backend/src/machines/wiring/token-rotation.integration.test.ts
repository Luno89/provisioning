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
import { loadKeys } from '../../platform/lib/keys.js';
import { roleFromEnv } from '../../platform/lib/platform-role.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { deviceTokenHash, TOKEN_EXPIRED_SAID } from '../lib/device-tokens.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { MachineService } from '../services/MachineService.js';
import { MachineTemporalGateway } from '../services/MachineTemporalGateway.js';
import { deviceByToken } from './machines.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';

const DAY = 24 * 60 * 60 * 1000;
const ISSUED = new Date('2026-10-10T00:00:00Z');
const OLD_TOKEN = 'the-token-the-machine-joined-with-0123456789';
const POLL_PATH = '/temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue';

const keys = loadKeys({ JWT_SECRET: 'token-rotation-test-secret' });

let db: MongoDB;
let clock: Date;
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

function agent(token: string, onToken?: (token: string, ack: (answer: { taken: boolean }) => void) => void): Promise<{ socket: ClientSocket; error?: string }> {
  const socket = connect(`${url}/agent`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  if (onToken) socket.on('machine:token', ({ token: next }: { token: string }, ack: (answer: { taken: boolean }) => void) => onToken(next, ack));
  return new Promise((resolve) => {
    socket.once('connect', () => resolve({ socket }));
    socket.once('connect_error', (err: Error) => resolve({ socket, error: err.message }));
  });
}

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
  deviceFor: deviceByToken(db, keys.data, () => clock),
  remote: async () => undefined,
});

const gitAnswer = async (token: string) => (await git().serve({ token, repo: 'nowhere', route: 'info/refs', service: 'git-upload-pack' } as never)).status;

beforeEach(async () => {
  db = await testDatabase();
  clock = new Date(ISSUED.getTime() + 65 * DAY);
  folder = await mkdtemp(path.join(tmpdir(), 'koala-machine-'));
  machines = new MachineService({
    store: db.machines,
    dataKey: keys.data,
    settings: { url: 'http://koala.test', temporalAddress: 'localhost:7234', temporalNamespace: 'default' },
    devices: {} as never,
    projects: { register: async () => { throw new Error('not used'); } },
    now: () => clock,
  });
  server = http.createServer();
  io = new SocketServer(server);
  wireSockets({
    io, db, role: roleFromEnv({}), env: {}, payloadKey: keys.payload, dataKey: keys.data,
    auth: { sessionFromCookie: async () => undefined, securedFor: () => false, principalFor: () => undefined } as unknown as SocketsWiringDeps['auth'],
    sessionSockets: { track: () => undefined, forget: () => undefined },
    machines, clusters: {} as never, apps: {} as never, infra: {} as never,
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
    deviceOf: deviceByToken(db, keys.data, () => clock),
    handed: async () => undefined,
  });
  machines.onTokenRetired((hash) => gateway.forget(hash));
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

describe('a machine token in its last 30 days, with the clock wound forward', () => {
  it('is replaced over the socket, written by the agent, and the old one is refused by the socket, the git proxy and the gateway', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    const file = path.join(folder, 'machine.json');
    expect(await gatewayAnswer(OLD_TOKEN)).not.toMatch(/not known here/);
    let received = '';
    const first = await agent(OLD_TOKEN, (next, ack) => {
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

    expect((await agent(saved.token)).error).toBeUndefined();
    expect(await gitAnswer(saved.token)).not.toBe(401);
    expect(await gatewayAnswer(saved.token)).not.toMatch(/not known here/);

    expect((await agent(OLD_TOKEN)).error).toBe('Unauthorized');
    expect(await gitAnswer(OLD_TOKEN)).toBe(401);
    expect(await gatewayAnswer(OLD_TOKEN)).toMatch(/not known here/);
  });

  it('keeps both tokens working when the agent stops between receiving the new one and saying it took it', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    let received = '';
    const first = await agent(OLD_TOKEN, (next) => { received = next; });
    expect(first.error).toBeUndefined();
    await until(async () => (received && (await stored()).nextTokenHash ? true : undefined));
    first.socket.close();

    expect((await agent(OLD_TOKEN)).error).toBeUndefined();
    expect(await gitAnswer(OLD_TOKEN)).not.toBe(401);
    expect(await gitAnswer(received)).not.toBe(401);
    expect(await gatewayAnswer(received)).not.toMatch(/not known here/);

    expect((await agent(received)).error).toBeUndefined();
    await until(async () => ((await stored()).tokenHash === deviceTokenHash(received) ? true : undefined));
    expect((await agent(OLD_TOKEN)).error).toBe('Unauthorized');
    expect(await gitAnswer(OLD_TOKEN)).toBe(401);
  }, 30_000);
});

describe('a machine token past its expiry', () => {
  it('is refused everywhere, and the socket says to run the command from My Machines again', async () => {
    await db.machines.saveLocalAgentDevice(device({ issuedAt: ISSUED, expiresAt: new Date(ISSUED.getTime() + 90 * DAY) }));
    clock = new Date(ISSUED.getTime() + 91 * DAY);
    expect((await agent(OLD_TOKEN)).error).toBe(TOKEN_EXPIRED_SAID);
    expect(await gitAnswer(OLD_TOKEN)).toBe(401);
    expect(await gatewayAnswer(OLD_TOKEN)).toMatch(/not known here/);
  }, 30_000);
});
