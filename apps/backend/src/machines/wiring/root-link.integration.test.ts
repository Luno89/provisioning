import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server as SocketServer } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import { linkToRoot, type Koala, type RootLink } from '../../../../local-agent/src/root-link.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { machineClientsAt } from '../../instances/testing/registration-code.js';
import { deviceTokenHash, tokenLifetime } from '../lib/device-tokens.js';
import { MachineAccounts, type MachineRemovals } from '../services/MachineAccounts.js';
import { wireMachineAccounts } from './accounts.js';
import { closedAfterEach, until } from '../testing/wiring-world.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';

const DAY = 24 * 3600 * 1000;
const closers = closedAfterEach();

async function root(clock: () => Date, koala: { url: string; audience: string } | null = { url: 'http://koala.test', audience: 'inst-1' }, removals?: MachineRemovals) {
  const db: Database = await testDatabase();
  const server = http.createServer();
  const io = new SocketServer(server);
  let accounts: MachineAccounts | undefined;
  const dependencies = new DependencyStates({ process: 'backend', described: ['mongo', 'temporal'] });
  const sockets = wireMachineAccounts({ io, db, accounts: () => accounts!, installs: () => ({ connected: async () => undefined }), dependencies, now: clock });
  closers.push(() => sockets.watched.close());
  await sockets.watched.ready;
  accounts = new MachineAccounts({
    ...(removals ? { removals } : {}),
    store: db.machines, signing: identityKeysFrom(generateIdentityKey()), clients: machineClientsAt(db), settings: { url: 'http://root.test' },
    koala: { of: async () => koala ?? undefined },
    followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: sockets,
    now: clock,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(async () => { await io.close(); });
  return { db, accounts, sockets, dependencies, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function machine(db: Database, token: string, issued: Date): Promise<void> {
  await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: issued.toISOString(), tokenHash: deviceTokenHash(token), ...tokenLifetime(issued) });
}

const ISSUED = new Date('2026-11-01T00:00:00Z');

async function removingRoot() {
  const told: { ownerId: string; word: { id: string; problem?: string | undefined } }[] = [];
  const world = await root(() => ISSUED, null, { uninstalled: async (ownerId, word) => { told.push({ ownerId, word }); } });
  await machine(world.db, 'a-token', ISSUED);
  return { ...world, told };
}

function removedLink(url: string, onRemoved: () => Promise<void>): { ended: () => boolean } {
  let ended = false;
  const link = linkToRoot({
    rootUrl: url, token: 'a-token', configFile: '/nonexistent/machine.json',
    meshIp: async () => undefined, onKoala: () => undefined, say: () => undefined,
    onRemoved, onRemovedEnd: () => { ended = true; },
  });
  closers.push(() => link.close());
  return { ended: () => ended };
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

  it('has a machine of an account being removed uninstall when it is back, and only once it said so forgets it and tells the removal', async () => {
    const { db, url, told } = await removingRoot();
    await db.machines.markDevicesRemoving('bo', ISSUED.toISOString());
    let finishUninstall!: () => void;
    const uninstalling = new Promise<void>((resolve) => { finishUninstall = resolve; });
    let asked = 0;
    const { ended } = removedLink(url, async () => { asked += 1; await uninstalling; });
    await until(() => (asked ? true : undefined));
    expect((await db.machines.getLocalAgentDevices()).map((device) => device.id), 'root keeps the machine while it uninstalls').toEqual(['desk']);
    expect(told).toEqual([]);
    finishUninstall();
    await until(() => (ended() ? true : undefined));
    expect(await db.machines.getLocalAgentDevices()).toEqual([]);
    expect(told).toEqual([{ ownerId: 'bo', word: { id: 'desk' } }]);
    expect(asked).toBe(1);
  });

  it('forgets a machine that said it uninstalled once the database root could not reach answers again, without asking the machine again', async () => {
    const told: { ownerId: string; word: { id: string; problem?: string | undefined } }[] = [];
    let refused = 0;
    const world = await root(() => ISSUED, null, {
      uninstalled: async (ownerId, word) => {
        if (refused === 0) { refused += 1; throw new Error('connect ECONNREFUSED 127.0.0.1:27017'); }
        told.push({ ownerId, word });
      },
    });
    await machine(world.db, 'a-token', ISSUED);
    await world.db.machines.markDevicesRemoving('bo', ISSUED.toISOString());
    const forgetting = vi.spyOn(world.accounts, 'uninstalled');
    let asked = 0;
    const { ended } = removedLink(world.url, async () => { asked += 1; });
    await until(() => (refused ? true : undefined));
    const firstTry = forgetting.mock.results[0]?.value as Promise<void> | undefined;
    expect(await firstTry?.then(() => 'forgotten', () => 'refused')).toBe('refused');
    world.dependencies.wentDown('mongo', 'connect ECONNREFUSED 127.0.0.1:27017', ISSUED.toISOString());
    world.dependencies.answered('mongo');
    expect(forgetting, 'root tries again the moment the database answers').toHaveBeenCalledTimes(2);
    await until(() => (ended() ? true : undefined));
    expect(await world.db.machines.getLocalAgentDevices()).toEqual([]);
    expect(told).toEqual([{ ownerId: 'bo', word: { id: 'desk' } }]);
    expect(asked, 'the machine is asked once').toBe(1);
  });

  it('keeps when a machine went off, and forgets it when the machine is back', async () => {
    const issued = new Date('2026-11-01T00:00:00Z');
    const { db, sockets, url } = await root(() => issued, null);
    await machine(db, 'a-token', issued);
    await db.machines.updateLocalAgentDevice('desk', { set: { offSince: '2026-10-31T00:00:00.000Z' } });
    const link = linkToRoot({ rootUrl: url, token: 'a-token', configFile: '/nonexistent/machine.json', meshIp: async () => undefined, onKoala: () => undefined, onRemoved: () => undefined, say: () => undefined });
    closers.push(() => link.close());
    await until(() => (sockets.online('desk') ? true : undefined));
    expect(await until(async () => ((await db.machines.getLocalAgentDevices())[0]?.offSince === undefined ? true : undefined))).toBe(true);
    link.close();
    expect(await until(async () => (await db.machines.getLocalAgentDevices())[0]?.offSince)).toBe(issued.toISOString());
  });

  it('tells a connected machine the moment its account\'s removal marks it, and passes on why its uninstall did not finish', async () => {
    const { db, sockets, url, told } = await removingRoot();
    const { ended } = removedLink(url, async () => { throw new Error('k3s is still on this machine'); });
    await until(() => (sockets.online('desk') ? true : undefined));
    await db.machines.markDevicesRemoving('bo', ISSUED.toISOString());
    await until(() => (ended() ? true : undefined));
    expect(told).toEqual([{ ownerId: 'bo', word: { id: 'desk', problem: 'k3s is still on this machine' } }]);
    expect(await db.machines.getLocalAgentDevices()).toEqual([]);
  });

  it('hands the agent root\'s word to stop an install on the machine, saying whether to remove what it made', async () => {
    const issued = new Date('2026-11-01T00:00:00Z');
    const { db, sockets, url } = await root(() => issued);
    await machine(db, 'a-token', issued);
    const stops: unknown[] = [];
    const link = linkToRoot({
      rootUrl: url, token: 'a-token', configFile: '/nonexistent/machine.json',
      meshIp: async () => undefined, onKoala: () => undefined, onRemoved: () => undefined, onStopKoala: (raw) => stops.push(raw), say: () => undefined,
    });
    closers.push(() => link.close());
    await until(() => (sockets.online('desk') ? true : undefined));
    expect(sockets.stopKoala('desk', { installId: 'install-1' })).toBe(true);
    expect(sockets.stopKoala('elsewhere', { installId: 'install-2' })).toBe(false);
    expect(await until(() => stops[0])).toEqual({ installId: 'install-1' });
  });
});
