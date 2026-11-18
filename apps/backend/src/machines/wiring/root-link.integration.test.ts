import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server as SocketServer } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { linkToRoot, type Koala, type RootLink } from '../../../../local-agent/src/root-link.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { deviceTokenHash, tokenLifetime } from '../lib/device-tokens.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { wireMachineAccounts } from './accounts.js';

const DAY = 24 * 3600 * 1000;
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function until<T>(look: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function root(clock: () => Date, koala: { url: string; audience: string } | null = { url: 'http://koala.test', audience: 'inst-1' }) {
  const db: Database = await testDatabase();
  const server = http.createServer();
  const io = new SocketServer(server);
  let accounts: MachineAccounts | undefined;
  const sockets = wireMachineAccounts({ io, db, accounts: () => accounts!, installs: () => ({ connected: async () => undefined }), now: clock });
  accounts = new MachineAccounts({
    store: db.machines, signing: identityKeysFrom(generateIdentityKey()), settings: { url: 'http://root.test' },
    koala: { of: async () => koala ?? undefined },
    followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: sockets,
    now: clock,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(async () => { await io.close(); });
  return { db, accounts, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function machine(db: Database, token: string, issued: Date): Promise<void> {
  await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: issued.toISOString(), tokenHash: deviceTokenHash(token), ...tokenLifetime(issued) });
}

describe('a machine agent\'s link to root, against root\'s real socket', () => {
  it('tells root its mesh address, takes the Koala root names when it connects and when root tells it, asks again without asking forever though root\'s clock is a month behind, and writes a token root rotates', async () => {
    const issued = new Date('2026-08-01T00:00:00Z');
    const now = new Date(issued.getTime() + 70 * DAY);
    const { db, url, accounts: accountsOf } = await root(() => now);
    await machine(db, 'first-token', issued);
    const folder = await mkdtemp(path.join(tmpdir(), 'root-link-'));
    closers.push(() => rm(folder, { recursive: true, force: true }));
    const koalas: Koala[] = [];
    const link: RootLink = linkToRoot({
      rootUrl: url, token: 'first-token', configFile: path.join(folder, 'machine.json'),
      meshIp: async () => '100.64.0.42', onKoala: (koala) => koalas.push(koala), onRemoved: () => undefined, say: () => undefined,
    });
    closers.push(() => link.close());
    await until(() => (koalas.length ? true : undefined));
    expect(koalas[0]!.url).toBe('http://koala.test');
    expect(await until(async () => (await db.machines.getLocalAgentDevices())[0]?.meshIp)).toBe('100.64.0.42');
    const saved = await until(async () => readFile(path.join(folder, 'machine.json'), 'utf8').then((text) => JSON.parse(text) as { token: string }, () => undefined));
    expect(saved.token).not.toBe('first-token');
    expect(await until(async () => ((await db.machines.getLocalAgentDevices())[0]?.tokenHash === deviceTokenHash(saved.token) ? true : undefined))).toBe(true);
    const before = koalas.length;
    await accountsOf.tellKoala('bo');
    await until(() => (koalas.length > before ? true : undefined));
    const asked = koalas.length;
    link.askKoala();
    await until(() => (koalas.length > asked ? true : undefined));
    await new Promise((done) => setTimeout(done, 300));
    expect(koalas.length).toBeLessThanOrEqual(asked + 1);
  });

  it('stops trying and tells the agent when root removes the machine, and says when no Koala is named', async () => {
    const issued = new Date('2026-11-01T00:00:00Z');
    const { db, accounts, url } = await root(() => issued, null);
    await machine(db, 'a-token', issued);
    const said: string[] = [];
    let removed = false;
    const link = linkToRoot({
      rootUrl: url, token: 'a-token', configFile: '/nonexistent/machine.json',
      meshIp: async () => undefined, onKoala: () => undefined, onRemoved: () => { removed = true; }, say: (line) => said.push(line),
    });
    closers.push(() => link.close());
    await until(() => (said.some((line) => line.includes('names no Koala')) ? true : undefined));
    expect(await accounts.remove('bo', 'desk')).toBe(true);
    await until(() => (removed ? true : undefined));
    expect(link.socket.io.opts.reconnection).toBe(false);
  });
});
