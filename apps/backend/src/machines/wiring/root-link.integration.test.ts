import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import { linkToRoot, type Koala, type RootLink } from '../../../../local-agent/src/root-link.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { machineClientsAt, machineSignInKey, machineTokenAt } from '../../instances/testing/registration-code.js';
import { MachineAccounts, type MachineRemovals } from '../services/MachineAccounts.js';
import { wireMachineAccounts } from './accounts.js';
import { closedAfterEach, until } from '../testing/wiring-world.js';
import { DependencyStates } from '../../platform/services/DependencyStates.js';
import { clientKeysFrom, clientPublicJwkOf, keyReplacementFrom, machineClientOf, METRICS_CLIENT_SECRET, metricsClientFrom, newClientKey } from '@koala/engine-core/root-client';
import { metricsClientFile } from '../../../../local-agent/src/machine-config.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { heldMachineKey } from '../../../../local-agent/src/machine-key.js';
import { joiningRoot } from '../testing/joining-root.js';

const DAY = 24 * 3600 * 1000;
const closers = closedAfterEach();

async function root(clock: () => Date, koala: { url: string; audience: string } | null = { url: 'http://koala.test', audience: 'inst-1' }, removals?: MachineRemovals) {
  const db: Database = await testDatabase();
  const server = http.createServer();
  const io = new SocketServer(server);
  let accounts: MachineAccounts | undefined;
  const dependencies = new DependencyStates({ process: 'backend', described: ['mongo', 'temporal'] });
  const sockets = wireMachineAccounts({ io, db, clients: machineClientsAt(db), accounts: () => accounts!, installs: () => ({ connected: async () => undefined }), dependencies, now: clock });
  closers.push(() => sockets.watched.close());
  await sockets.watched.ready;
  accounts = new MachineAccounts({
    ...(removals ? { removals } : {}),
    store: db.machines, clients: machineClientsAt(db), settings: { url: 'http://root.test' },
    koala: { of: async () => koala ?? undefined },
    followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: sockets,
    now: clock,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(async () => { await io.close(); });
  return { db, io, accounts, sockets, dependencies, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function machine(db: Database, issued: Date): Promise<void> {
  await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: issued.toISOString(), signIn: machineSignInKey() });
}

const keyOf = (db: Database) => ({ token: () => machineTokenAt(db, 'desk'), freshToken: () => machineTokenAt(db, 'desk') });

const ISSUED = new Date('2026-11-01T00:00:00Z');

async function removingRoot() {
  const told: { ownerId: string; word: { id: string; problem?: string | undefined } }[] = [];
  const world = await root(() => ISSUED, null, { uninstalled: async (ownerId, word) => { told.push({ ownerId, word }); } });
  await machine(world.db,ISSUED);
  return { ...world, told };
}

function removedLink(world: { url: string; db: Database }, onRemoved: () => Promise<void>): { ended: () => boolean } {
  let ended = false;
  const link = linkToRoot({
    rootUrl: world.url, client: keyOf(world.db),
    meshIp: async () => undefined, onKoala: () => undefined, say: () => undefined,
    onRemoved, onRemovedEnd: () => { ended = true; },
  });
  closers.push(() => link.close());
  return { ended: () => ended };
}

describe('a machine agent\'s link to root, against root\'s real socket', () => {
  it('replaces its key when root offers it one as its key nears its end, and root records why when it could not', async () => {
    const now = new Date();
    const { db, url } = await root(() => now);
    await machine(db,ISSUED);
    await db.machines.updateLocalAgentDevice('desk', { set: { signIn: { ...machineSignInKey(), since: new Date(now.getTime() - 70 * DAY).toISOString() } } });
    const offers: unknown[] = [];
    let koalas = 0;
    let firstKoala: () => void = () => undefined;
    let secondKoala: () => void = () => undefined;
    const toldOnce = new Promise<void>((done) => { firstKoala = done; });
    const toldTwice = new Promise<void>((done) => { secondKoala = done; });
    const link: RootLink = linkToRoot({
      rootUrl: url, client: keyOf(db),
      meshIp: async () => undefined, onRemoved: () => undefined, say: () => undefined,
      onKoala: () => { koalas += 1; if (koalas === 1) firstKoala(); if (koalas === 2) secondKoala(); },
      onReplaceKey: async (offer) => { offers.push(offer); throw new Error('the disk was full'); },
    });
    closers.push(() => link.close());
    await toldOnce;
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ registrationClientUri: 'http://127.0.0.1:1/oidc/reg/desk' });
    expect(keyReplacementFrom(offers[0])).toBeDefined();
    link.askKoala();
    await toldTwice;
    expect((await db.machines.getLocalAgentDevices())[0]?.keyReplacement?.reason).toBe('the disk was full');
  });

  it('connects again with its old key when root took a new one though its answer never reached the agent, and the repeated replacement brings the Prometheus secret root kept waiting, after which root keeps only the newest key', async () => {
    const now = new Date();
    const { db, io, url } = await root(() => now);
    await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: now.toISOString() });
    const provider = await joiningRoot(db, closers);
    const first = newClientKey();
    await machineClientOf({ rootUrl: provider.url, deviceId: 'desk', key: first, registrationCode: await provider.root.provider.machineRegistrationCode({ id: 'desk', ownerId: 'bo' }) }).register();
    const home = await mkdtemp(path.join(os.tmpdir(), 'root-link-key-'));
    closers.push(() => rm(home, { recursive: true, force: true }));
    const file = path.join(home, 'machine.json');
    await writeFile(file, JSON.stringify({ rootUrl: url, deviceId: 'desk', rootDir: home, key: first }), { mode: 0o600 });
    let lost: Record<string, unknown> | undefined;
    const answerLost: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init);
      if (init?.method !== 'PUT' || lost) return answer;
      lost = await answer.json() as Record<string, unknown>;
      throw new Error('the connection dropped before root\'s answer came');
    };
    const held = await heldMachineKey(file, (key) => machineClientOf({ rootUrl: provider.url, deviceId: 'desk', key, reach: answerLost }));
    const koalas: Koala[] = [];
    const waiting: Array<{ count: number; done: () => void }> = [];
    let gaveUp: (why: Error) => void = () => undefined;
    const refused = new Promise<never>((_, fail) => { gaveUp = fail; });
    const koalaNumber = (count: number): Promise<void> => Promise.race([
      new Promise<void>((done) => { if (koalas.length >= count) done(); else waiting.push({ count, done }); }),
      refused,
    ]);
    const link: RootLink = linkToRoot({
      rootUrl: url, client: held,
      meshIp: async () => undefined, onRemoved: () => undefined, say: () => undefined,
      onKoala: (koala) => {
        koalas.push(koala);
        for (const wait of waiting) if (koalas.length >= wait.count) wait.done();
      },
    });
    closers.push(() => link.close());
    link.socket.on('connect_error', (err: Error) => { if (!link.socket.active) gaveUp(new Error(`root refused the agent and it does not try again: ${err.message}`)); });
    await koalaNumber(1);
    await expect(held.replaceKey(await provider.root.provider.keyReplacement('desk'))).rejects.toThrow('the connection dropped before root\'s answer came');
    const saved = JSON.parse(await readFile(file, 'utf8')) as { key: string; nextKey?: string };
    expect(saved.nextKey).toBeTruthy();
    expect((await db.machines.getLocalAgentDevices())[0]?.signIn?.jwk).toEqual(clientPublicJwkOf(clientKeysFrom(saved.nextKey!)));
    for (const socket of io.of('/machine-account').sockets.values()) socket.conn.close();
    await koalaNumber(2);
    await held.replaceKey(await provider.root.provider.keyReplacement('desk'));
    const kept = JSON.parse(await readFile(file, 'utf8')) as { key: string; nextKey?: string };
    expect(kept).toEqual({ rootUrl: url, deviceId: 'desk', rootDir: home, key: kept.key });
    expect([first, saved.nextKey]).not.toContain(kept.key);
    const metrics = JSON.parse(await readFile(metricsClientFile(file), 'utf8')) as { items: Array<{ stringData?: Record<string, string> }> };
    expect(metrics.items[1]?.stringData?.[METRICS_CLIENT_SECRET.secretKey]).toBe(metricsClientFrom(lost).clientSecret);
    await held.freshToken();
    const [device] = await db.machines.getLocalAgentDevices();
    expect([device?.signIn?.jwk, device?.previousSignIn]).toEqual([clientPublicJwkOf(clientKeysFrom(kept.key)), undefined]);
  });

  it('tells root its mesh address, takes the Koala root names when it connects, when root tells it and when it asks, and asks nothing by itself though root\'s clock is a month behind', async () => {
    const issued = new Date('2026-08-01T00:00:00Z');
    const now = new Date(issued.getTime() + 70 * DAY);
    const { db, url, accounts: accountsOf } = await root(() => now);
    await machine(db,issued);
    const koalas: Koala[] = [];
    const link: RootLink = linkToRoot({
      rootUrl: url, client: keyOf(db),
      meshIp: async () => '100.64.0.42', onKoala: (koala) => koalas.push(koala), onRemoved: () => undefined, say: () => undefined,
    });
    closers.push(() => link.close());
    await until(() => (koalas.length >= 1 ? true : undefined));
    expect(koalas[0]).toEqual({ url: 'http://koala.test', resource: expect.any(String) as unknown });
    expect(await until(async () => (await db.machines.getLocalAgentDevices())[0]?.meshIp)).toBe('100.64.0.42');
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
    await machine(db,issued);
    const said: string[] = [];
    let removed = false;
    const link = linkToRoot({
      rootUrl: url, client: keyOf(db),
      meshIp: async () => undefined, onKoala: () => undefined, onRemoved: () => { removed = true; }, say: (line) => said.push(line),
    });
    closers.push(() => link.close());
    await until(() => (said.some((line) => line.includes('names no Koala')) ? true : undefined));
    expect(await accounts.remove('bo', 'desk')).toBe(true);
    await until(() => (removed ? true : undefined));
    expect(link.socket.io.opts.reconnection).toBe(false);
  });

  it('has a machine of an account being removed uninstall when it is back, and only once it said so forgets it and tells the removal', async () => {
    const world = await removingRoot();
    const { db, told } = world;
    await db.machines.markDevicesRemoving('bo', ISSUED.toISOString());
    let finishUninstall!: () => void;
    const uninstalling = new Promise<void>((resolve) => { finishUninstall = resolve; });
    let asked = 0;
    const { ended } = removedLink(world, async () => { asked += 1; await uninstalling; });
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
    await machine(world.db,ISSUED);
    await world.db.machines.markDevicesRemoving('bo', ISSUED.toISOString());
    const forgetting = vi.spyOn(world.accounts, 'uninstalled');
    let asked = 0;
    const { ended } = removedLink(world, async () => { asked += 1; });
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
    await machine(db,issued);
    await db.machines.updateLocalAgentDevice('desk', { set: { offSince: '2026-10-31T00:00:00.000Z' } });
    const link = linkToRoot({ rootUrl: url, client: keyOf(db), meshIp: async () => undefined, onKoala: () => undefined, onRemoved: () => undefined, say: () => undefined });
    closers.push(() => link.close());
    await until(() => (sockets.online('desk') ? true : undefined));
    expect(await until(async () => ((await db.machines.getLocalAgentDevices())[0]?.offSince === undefined ? true : undefined))).toBe(true);
    link.close();
    expect(await until(async () => (await db.machines.getLocalAgentDevices())[0]?.offSince)).toBe(issued.toISOString());
  });

  it('tells a connected machine the moment its account\'s removal marks it, and passes on why its uninstall did not finish', async () => {
    const world = await removingRoot();
    const { db, sockets, told } = world;
    const { ended } = removedLink(world, async () => { throw new Error('k3s is still on this machine'); });
    await until(() => (sockets.online('desk') ? true : undefined));
    await db.machines.markDevicesRemoving('bo', ISSUED.toISOString());
    await until(() => (ended() ? true : undefined));
    expect(told).toEqual([{ ownerId: 'bo', word: { id: 'desk', problem: 'k3s is still on this machine' } }]);
    expect(await db.machines.getLocalAgentDevices()).toEqual([]);
  });

  it('hands the agent root\'s word to stop an install on the machine, saying whether to remove what it made', async () => {
    const issued = new Date('2026-11-01T00:00:00Z');
    const { db, sockets, url } = await root(() => issued);
    await machine(db,issued);
    const stops: unknown[] = [];
    const link = linkToRoot({
      rootUrl: url, client: keyOf(db),
      meshIp: async () => undefined, onKoala: () => undefined, onRemoved: () => undefined, onStopKoala: (raw) => stops.push(raw), say: () => undefined,
    });
    closers.push(() => link.close());
    await until(() => (sockets.online('desk') ? true : undefined));
    expect(sockets.stopKoala('desk', { installId: 'install-1' })).toBe(true);
    expect(sockets.stopKoala('elsewhere', { installId: 'install-2' })).toBe(false);
    expect(await until(() => stops[0])).toEqual({ installId: 'install-1' });
  });
});
