import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { signSocketsIn } from './socket-sign-in.js';
import { testDatabase } from '../lib/test-database.js';
import { SessionSockets } from '../services/SessionSockets.js';
import { rootAuthOver } from '../testing/root-auth.js';
import { openRoutesOf } from '../../open-routes.js';

const closing: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

async function serve(failing = false) {
  const db = await testDatabase();
  await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
  const sessionSockets = new SessionSockets();
  const { auth: real, sessions, revocations } = rootAuthOver(db, { open: openRoutesOf('root') });
  sessions.onEnd((sessionId) => sessionSockets.end({ kind: 'session', sessionId }));
  revocations.listen(async (revoked) => { sessionSockets.end({ kind: 'person', personId: revoked.personId, before: Date.parse(revoked.at) }); });
  const auth = failing ? { ...real, sessionOf: async () => { throw new Error('the database did not answer'); } } : real;
  const app = express();
  app.post('/hold', (req, res, next) => { real.holdAccount(req, { id: 'ann' }).then(() => res.json({}), next); });
  app.post('/out', (req, res, next) => { real.endSession(req).then(() => res.json({}), next); });
  const server = http.createServer(app);
  const io = new SocketServer(server);
  signSocketsIn(io, { auth, sessionSockets });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closing.push(async () => { await Promise.all([io.close(), new Promise<void>((resolve) => server.close(() => resolve()))]); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (): Promise<string> => {
    const held = await fetch(`${url}/hold`, { method: 'POST' });
    const cookie = held.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('koala_sid='));
    if (!cookie) throw new Error(`signing in set no session cookie (${held.status})`);
    return cookie;
  };
  const signOut = async (cookie: string): Promise<void> => {
    const out = await fetch(`${url}/out`, { method: 'POST', headers: { cookie } });
    if (out.status !== 200) throw new Error(`signing out answered ${out.status}`);
  };
  return { revocations, sessionSockets, url, signIn, signOut };
}

const opened = (url: string, cookie: string): Promise<{ socket: ClientSocket; closed: Promise<string> }> => new Promise((resolve, reject) => {
  const socket = connect(url, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false, forceNew: true });
  closing.push(async () => { socket.close(); });
  const closed = new Promise<string>((done) => socket.on('disconnect', (reason) => done(reason)));
  socket.on('connect', () => resolve({ socket, closed }));
  socket.on('connect_error', (err) => reject(err));
});

const refusal = (url: string, cookie: string): Promise<Error & { data?: unknown }> => opened(url, cookie).then(() => { throw new Error('it connected'); }, (err: Error & { data?: unknown }) => err);

describe('signing a connection in', () => {
  it('a handshake without a session is refused', async () => {
    const { url } = await serve();
    const refused = await new Promise<Error>((resolve, reject) => {
      const socket = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
      closing.push(async () => { socket.close(); });
      socket.on('connect', () => reject(new Error('it connected')));
      socket.on('connect_error', resolve);
    });
    expect(refused.message).toBe('Unauthorized');
  });
});

describe('an open connection ends with its session', () => {
  it('closes the connection made with a session signed out of, keeps the others, and refuses it again', async () => {
    const { sessionSockets, url, signIn, signOut } = await serve();
    const left = await signIn();
    const kept = await signIn();
    const leaving = await opened(url, left);
    const staying = await opened(url, kept);
    expect(sessionSockets.size).toBe(2);
    await signOut(left);
    expect(await leaving.closed).toBe('io server disconnect');
    expect(staying.socket.connected).toBe(true);
    await expect(opened(url, left)).rejects.toThrow('Unauthorized');
  });

  it('closes every connection of a person whose sessions were ended, but not one from a session begun after', async () => {
    const { revocations, url, signIn } = await serve();
    const before = await opened(url, await signIn());
    const beforeToo = await opened(url, await signIn());
    await revocations.revoked({ personId: 'ann', because: 'signed-out-everywhere', at: new Date().toISOString() });
    expect(await before.closed).toBe('io server disconnect');
    expect(await beforeToo.closed).toBe('io server disconnect');
    const after = await opened(url, await signIn());
    expect(after.socket.connected).toBe(true);
  });
});

describe('a session the server could not check', () => {
  it('is refused as one to try again, never as Unauthorized, so the browser does not take it for signed out', async () => {
    const { url, signIn } = await serve(true);
    const refused = await refusal(url, await signIn());
    expect(refused.message).toBe('the session could not be checked; try again');
    expect(refused.data).toEqual({ tryAgain: true });
  });

  it('refuses a session that is not one as Unauthorized, with nothing to try again', async () => {
    const { url } = await serve();
    const refused = await refusal(url, 'koala_sid=not-a-session');
    expect(refused.message).toBe('Unauthorized');
    expect(refused.data).toBeUndefined();
  });
});
