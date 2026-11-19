import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptiedEachTime, testPayloadBlobs } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { principalOf } from '../../platform/lib/permissions.js';
import { testKeys } from '../../platform/testing/keys.js';
import { onlineMachines, until } from '../testing/wiring-world.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';

const fresh = await emptiedEachTime();
const keys = testKeys('run-logs-secret');
const BO = { id: 'bo', email: 'bo@koala.test' };
const AL = { id: 'al', email: 'al@koala.test' };

let db: MongoDB;
let server: http.Server;
let io: SocketServer;
let url = '';
let folder = '';
const clients: ClientSocket[] = [];

beforeEach(async () => {
  db = await fresh();
  folder = await mkdtemp(path.join(tmpdir(), 'koala-run-logs-'));
  server = http.createServer();
  io = new SocketServer(server);
  const people: Record<string, typeof BO> = { 'session=bo': BO, 'session=al': AL };
  wireSockets({
    io, db, role: { role: 'instance', instance: { id: 'inst-1', ownerId: 'bo', rootUrl: 'http://root.test' } }, payloadBlobs: testPayloadBlobs().blobs, payloadKey: keys.payload, dataKey: keys.data,
    auth: {
      sessionFromCookie: async (cookie: string | undefined) => { const user = cookie ? people[cookie] : undefined; return user ? { user, sessionId: `${user.id}-session`, sessionAt: new Date().toISOString() } : undefined; },
      securedFor: () => false,
      principalFor: (user: { id: string }) => principalOf(user, { role: 'instance', instanceOwnerId: 'bo' }),
    } as unknown as SocketsWiringDeps['auth'],
    sessionSockets: { track: () => undefined, forget: () => undefined },
    machines: onlineMachines(db.machines),
    clusters: { access: {}, getById: async () => undefined } as never,
    apps: { getById: async () => undefined } as never,
    telemetry: { relay: async () => ({ ok: true }) } as never,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await io.close();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(folder, { recursive: true, force: true });
});

const browserOf = async (cookie: string): Promise<{ socket: ClientSocket; heard: string[]; denied: unknown[] }> => {
  const socket = connect(url, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  const heard: string[] = [];
  const denied: unknown[] = [];
  socket.on('log', (text: string) => { heard.push(text); });
  socket.on('room-denied', (said: unknown) => { denied.push(said); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
  return { socket, heard, denied };
};

describe('a person following a build\'s log in the browser', () => {
  it('sees the lines the build wrote so far and each line it writes after, and someone else sees none of it', async () => {
    const logFile = path.join(folder, 'run-1.log');
    await writeFile(logFile, 'cloning bo-shop\n');
    await db.projects.saveProject({ id: 'bo-shop', name: 'bo-shop', ownerId: 'bo', createdAt: new Date().toISOString() } as never);
    await db.releases.savePipelineRun({ id: 'run-1', projectId: 'bo-shop', commitSha: 'abc123', ref: 'main', status: 'running', logFile, startedAt: new Date().toISOString() });

    const bo = await browserOf('session=bo');
    bo.socket.emit('join-room', 'run-1');
    await until(async () => (bo.heard.join('').includes('cloning bo-shop\n') ? true : undefined));
    await appendFile(logFile, 'building the image\n');
    await until(async () => (bo.heard.join('').includes('building the image\n') ? true : undefined));
    expect(bo.heard.join('')).toBe('cloning bo-shop\nbuilding the image\n');

    const al = await browserOf('session=al');
    al.socket.emit('join-room', 'run-1');
    expect(await until(async () => al.denied[0])).toEqual({ id: 'run-1' });
    expect(al.heard).toEqual([]);
  });
});
