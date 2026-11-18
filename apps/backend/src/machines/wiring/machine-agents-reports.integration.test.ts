import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { runSteps } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { joinArgsOf } from '../../../../local-agent/src/join/args.js';
import { localJoinHost } from '../../../../local-agent/src/join/host.js';
import { joinPins } from '../../../../local-agent/src/join/pins.js';
import { joinRootStep, keepAgentsNotSetUp } from '../../../../local-agent/src/join/steps/join-root.js';
import type { JoinContext } from '../../../../local-agent/src/join/context.js';
import { reportAgents, type DiscoveryDeps } from '../../../../local-agent/src/agent-discovery.js';
import { agentsNotSetUp } from '../../../../local-agent/src/machine-config.js';
import { testKeys } from '../../platform/testing/keys.js';
import { testDatabase, testPayloadBlobs } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { issueWorkToken } from '../lib/work-tokens.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { MachineService } from '../services/MachineService.js';
import { machinesRouter } from '../routes/machines.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const signing = identityKeysFrom(generateIdentityKey());
const keys = testKeys('machine-agents-reports-secret');

const finding = (...commands: string[]): DiscoveryDeps => ({
  which: async (command) => (commands.includes(command) ? `/usr/bin/${command}` : undefined),
  exists: async () => false,
  probe: async (launch) => ({ identity: { name: launch.command, title: launch.command }, signIn: [] }),
});

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise<void>((done) => { server.close(() => done()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function koala() {
  const db: MongoDB = await testDatabase();
  const accounts = new MachineAccounts({
    store: db.machines, signing, settings: { url: 'http://root.test', meshLoginServer: 'https://mesh.test' },
    mesh: { createPreAuthKey: async () => ({ key: 'hskey' }), removeNode: async () => undefined },
    koala: { of: async () => undefined }, followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: { removed: () => false, koala: () => false, online: () => false },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/machines', machinesRouter({ accounts, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }));
  const rootUrl = await listening(http.createServer(app));
  const machines = new MachineService({
    store: db.machines,
    devices: { status: () => ({ online: true }) } as never,
    accounts: { createJoinCode: async () => { throw new Error('not used'); }, remove: async () => false },
    projects: { register: async () => { throw new Error('not used'); } },
  });
  const server = http.createServer();
  const io = new SocketServer(server);
  closers.push(() => new Promise<void>((done) => { void io.close(() => done()); }));
  wireSockets({
    io, db, role: { role: 'instance', instance: { id: 'inst-1', ownerId: 'bo', rootUrl: 'http://root.test' } }, payloadBlobs: testPayloadBlobs().blobs, payloadKey: keys.payload, dataKey: keys.data,
    auth: { sessionFromCookie: async () => undefined, securedFor: () => false, principalFor: () => undefined } as unknown as SocketsWiringDeps['auth'],
    sessionSockets: { track: () => undefined, forget: () => undefined },
    machines, workTokens: { keys: trustedKeys([publicKeyPem(signing.publicKey)]), audience: 'inst-1' }, clusters: {} as never, apps: {} as never,
    telemetry: { relay: async () => ({ ok: true }) } as never,
  });
  const koalaUrl = await listening(server);
  return { accounts, machines, rootUrl, koalaUrl };
}

async function machineHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'koala-agents-reports-'));
  closers.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

const settingsEnv = (home: string) => ({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') });

async function joined(rootUrl: string, code: string, home: string): Promise<JoinContext> {
  const args = joinArgsOf([code, '--url', rootUrl, '--yes', '--folder', path.join(home, 'koala')]);
  const host = localJoinHost({ env: settingsEnv(home), machineRoot: path.join(home, 'machine'), user: { uid: 1000, name: 'bo', group: 'bo', home }, hostname: 'desk' });
  const ctx: JoinContext = { args, host, commands: { run: async () => { throw new Error('the join step runs no command'); } }, pins: joinPins(undefined), folder: path.join(home, 'koala'), agentDir: path.join(home, 'agent'), node: process.execPath };
  await runSteps([joinRootStep(rootUrl)], ctx, memoryReporter());
  return ctx;
}

async function reports(koalaUrl: string, ctx: JoinContext, home: string, deps: DiscoveryDeps): Promise<void> {
  const token = issueWorkToken(signing, { machineId: ctx.joined!.deviceId, ownerId: 'bo', audience: 'inst-1' });
  const socket = connect(`${koalaUrl}/agent`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  closers.push(async () => { socket.close(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
  await reportAgents(deps, [], () => agentsNotSetUp(settingsEnv(home)), (report) => { socket.emit('agents:found', report); });
}

async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe('a machine whose coding agents its join could not set up', () => {
  it('joins, and My Machines shows its coding agents as not set up and why, from the machine\'s own report, until a join sets them up', async () => {
    const { accounts, machines, rootUrl, koalaUrl } = await koala();
    const home = await machineHome();
    const first = await joined(rootUrl, (await accounts.createJoinCode('bo')).code, home);
    await keepAgentsNotSetUp(first, 'the ACP registry could not be reached');
    await reports(koalaUrl, first, home, finding('gemini'));
    const shown = await until(async () => (await machines.list('bo')).find((machine) => machine.agents[0]?.state === 'ready'));
    expect(shown).toMatchObject({ id: first.joined!.deviceId, agentsNotSetUp: 'the ACP registry could not be reached', agents: [{ id: 'gemini', state: 'ready' }] });

    const again = await joined(rootUrl, (await accounts.createJoinCode('bo')).code, home);
    await reports(koalaUrl, again, home, finding('gemini', 'goose'));
    const after = await until(async () => (await machines.list('bo')).find((machine) => machine.id === again.joined!.deviceId && machine.agents.length === 2 && machine.agents.every((agent) => agent.state === 'ready')));
    expect(after.agents.map((agent) => agent.id)).toEqual(['gemini', 'goose']);
    expect(after).not.toHaveProperty('agentsNotSetUp');
  });
});
