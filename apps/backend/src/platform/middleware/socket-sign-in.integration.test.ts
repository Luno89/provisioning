import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { createAuth } from './auth.js';
import { signSocketsIn } from './socket-sign-in.js';
import { testDatabase } from '../lib/test-database.js';
import { sessionToken } from '../lib/auth.js';
import { SessionEnds } from '../services/SessionEnds.js';
import { SessionSockets } from '../services/SessionSockets.js';
import { AccessRevocations } from '../services/AccessRevocations.js';
import { endsSessions } from '../lib/revocations.js';

const KEY = 'socket-session-key';
const closing: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

async function serve(failing = false) {
  const db = await testDatabase();
  await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
  const sessionEnds = new SessionEnds(db.platform);
  const sessionSockets = new SessionSockets();
  const revocations = new AccessRevocations();
  sessionEnds.onEnd((sessionId) => sessionSockets.end({ kind: 'session', sessionId }));
  revocations.listen(async (revoked) => { if (endsSessions(revoked)) sessionSockets.end({ kind: 'person', personId: revoked.personId, before: Date.parse(revoked.at) }); });
  const real = createAuth({ db, sessionKey: KEY, publicUrl: 'http://localhost:3001', sessionEnds });
  const auth = failing ? { ...real, sessionFromCookie: async () => { throw new Error('the database did not answer'); } } : real;
  const server = http.createServer();
  const io = new SocketServer(server);
  signSocketsIn(io, { auth, db, env: {}, sessionSockets });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closing.push(async () => { await Promise.all([io.close(), new Promise<void>((resolve) => server.close(() => resolve()))]); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { auth, revocations, sessionSockets, url };
}

const opened = (url: string, token: string): Promise<{ socket: ClientSocket; closed: Promise<string> }> => new Promise((resolve, reject) => {
  const socket = connect(url, { transports: ['websocket'], extraHeaders: { cookie: `session=${token}` }, reconnection: false, forceNew: true });
  closing.push(async () => { socket.close(); });
  const closed = new Promise<string>((done) => socket.on('disconnect', (reason) => done(reason)));
  socket.on('connect', () => resolve({ socket, closed }));
  socket.on('connect_error', (err) => reject(err));
});

const refusal = (url: string, token: string): Promise<Error & { data?: unknown }> => opened(url, token).then(() => { throw new Error('it connected'); }, (err: Error & { data?: unknown }) => err);

describe('an open connection ends with its session', () => {
  it('closes the connection made with a session signed out of, keeps the others, and refuses it again', async () => {
    const { auth, sessionSockets, url } = await serve();
    const left = sessionToken({ id: 'ann', email: 'ann@example.com' }, KEY);
    const kept = sessionToken({ id: 'ann', email: 'ann@example.com' }, KEY);
    const leaving = await opened(url, left);
    const staying = await opened(url, kept);
    expect(sessionSockets.size).toBe(2);
    await auth.endSession({ headers: { cookie: `session=${left}` }, secure: false } as never);
    expect(await leaving.closed).toBe('io server disconnect');
    expect(staying.socket.connected).toBe(true);
    await expect(opened(url, left)).rejects.toThrow('Unauthorized');
  });

  it('closes every connection of a person whose sessions were ended, but not one from a session begun after', async () => {
    const { revocations, url } = await serve();
    const before = await opened(url, sessionToken({ id: 'ann', email: 'ann@example.com' }, KEY, { now: Date.now() - 60_000 }));
    const after = await opened(url, sessionToken({ id: 'ann', email: 'ann@example.com' }, KEY, { now: Date.now() + 60_000 }));
    await revocations.revoked({ personId: 'ann', because: 'signed-out-everywhere', at: new Date().toISOString() });
    expect(await before.closed).toBe('io server disconnect');
    expect(after.socket.connected).toBe(true);
    await revocations.revoked({ personId: 'ann', because: 'removed-from-shared-project', at: new Date(Date.now() + 120_000).toISOString(), sharedProjectId: 'sp1' });
    expect(after.socket.connected).toBe(true);
  });
});

describe('a session the server could not check', () => {
  it('is refused as one to try again, never as Unauthorized, so the browser does not take it for signed out', async () => {
    const { url } = await serve(true);
    const refused = await refusal(url, sessionToken({ id: 'ann', email: 'ann@example.com' }, KEY));
    expect(refused.message).toBe('the session could not be checked; try again');
    expect(refused.data).toEqual({ tryAgain: true });
  });

  it('refuses a session that is not one as Unauthorized, with nothing to try again', async () => {
    const { url } = await serve();
    const refused = await refusal(url, 'not-a-session');
    expect(refused.message).toBe('Unauthorized');
    expect(refused.data).toBeUndefined();
  });
});
