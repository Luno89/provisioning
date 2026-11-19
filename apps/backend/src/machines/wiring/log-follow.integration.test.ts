import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import type { Followed, Streams } from '@koala/engine-core/processes';
import { recordingProcesses, type RecordingProcesses } from '@koala/engine-core/testing/processes';
import { testKeys } from '../../platform/testing/keys.js';
import { testPayloadBlobs } from '../../platform/lib/test-database.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const keys = testKeys('log-follow-secret');

const watched = (recording: RecordingProcesses): { streams: Streams; followed: Followed[] } => {
  const followed: Followed[] = [];
  return { followed, streams: { ...recording, start: (run, io) => { const started = recording.start(run, io); followed.push(started); return started; } } };
};

async function koala(logPath: string, streams: Streams): Promise<string> {
  const server = http.createServer();
  const io = new SocketServer(server);
  closers.push(() => new Promise<void>((done) => { void io.close(() => done()); }));
  const person = { id: 'bo', email: 'bo@example.com' };
  wireSockets({
    io, db: {} as never, role: { role: 'instance', instance: { id: 'inst-1', ownerId: 'bo', rootUrl: 'http://root.test' } }, payloadBlobs: testPayloadBlobs().blobs, payloadKey: keys.payload, dataKey: keys.data,
    auth: { sessionFromCookie: async () => ({ user: person, sessionId: 's1', sessionAt: 0 }), securedFor: () => false, principalFor: () => ({ id: 'bo', claims: [] }) } as unknown as SocketsWiringDeps['auth'],
    sessionSockets: { track: () => undefined, forget: () => undefined },
    machines: {} as never,
    clusters: { getById: async (id: string) => (id === 'desk' ? { id, lastLogPath: logPath } : undefined) } as never,
    apps: {} as never,
    telemetry: {} as never,
    streams,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function signedIn(url: string): Promise<Socket> {
  const socket = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  closers.push(async () => { socket.close(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
  return socket;
}

const heard = (socket: Socket, wanted: string): Promise<string> => new Promise((resolve) => {
  let said = '';
  socket.on('log', (chunk: string) => {
    said += chunk;
    if (said.includes(wanted)) resolve(said);
  });
});

describe('following a resource\'s log in the browser', () => {
  it('shows what the log already says and what is added to it, from both of the follower\'s outputs', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'koala-log-follow-'));
    closers.push(() => rm(folder, { recursive: true, force: true }));
    const logPath = path.join(folder, 'logs', 'desk.log');
    const streams = recordingProcesses(() => ({ stdout: 'applied\n', stderr: 'tail: file truncated\n', runsUntilStopped: true }));
    const socket = await signedIn(await koala(logPath, watched(streams).streams));
    const said = heard(socket, 'truncated');
    socket.emit('join-room', 'desk');
    expect(await said).toBe('applied\ntail: file truncated\n');
    expect(streams.ran.map((run) => [run.command, ...run.args])).toEqual([['tail', '-n', '200', '-f', logPath]]);
  });

  it('stops following when the person leaves the room', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'koala-log-follow-'));
    closers.push(() => rm(folder, { recursive: true, force: true }));
    const streams = recordingProcesses(() => ({ stdout: 'ready\n', runsUntilStopped: true }));
    const { streams: following, followed } = watched(streams);
    const socket = await signedIn(await koala(path.join(folder, 'desk.log'), following));
    const said = heard(socket, 'ready');
    socket.emit('join-room', 'desk');
    await said;
    socket.emit('leave-room', 'desk');
    expect(await followed[0]?.ended).toMatchObject({ signal: 'SIGTERM' });
    expect(streams.recorded[0]?.stoppedWith).toBe('SIGTERM');
  });
});
