import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { describe, expect, it } from 'vitest';
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
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { joiningRoot } from '../testing/joining-root.js';
import { issueWorkToken } from '../lib/work-tokens.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { machinesRouter } from '../routes/machines.js';
import { wireSockets, type SocketsWiringDeps } from './sockets.js';
import type { MachineService } from '../services/MachineService.js';
import { closedAfterEach, connectedSocket, until, quietAccountSides, onlineMachines, agentSockets } from '../testing/wiring-world.js';

const closers = closedAfterEach();

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

async function wired(db: MongoDB, machines: SocketsWiringDeps['machines']): Promise<{ io: SocketServer; url: string }> {
  const server = http.createServer();
  const io = new SocketServer(server);
  closers.push(() => new Promise<void>((done) => { void io.close(() => done()); }));
  wireSockets(agentSockets({ io, db, payloadKey: keys.payload, dataKey: keys.data, machines, workTokens: { keys: trustedKeys([publicKeyPem(signing.publicKey)]), audience: 'inst-1' } }, 'bo'));
  return { io, url: await listening(server) };
}

async function connected(koalaUrl: string, deviceId: string) {
  const token = issueWorkToken(signing, { machineId: deviceId, ownerId: 'bo', audience: 'inst-1' });
  return connectedSocket(`${koalaUrl}/agent`, closers, { token });
}

async function koala() {
  const db: MongoDB = await testDatabase();
  const { app, url: rootUrl, root } = await joiningRoot(db, closers);
  const accounts = new MachineAccounts({
    ...quietAccountSides(rootUrl),
    store: db.machines, signing, clients: root.provider,
  });
  app.use(express.json());
  app.use('/api/machines', machinesRouter({ accounts, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }));
  const machines = onlineMachines(db.machines);
  const koalaUrl = (await wired(db, machines)).url;
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
  const socket = await connected(koalaUrl, ctx.joined!.deviceId);
  await reportAgents(deps, [], () => agentsNotSetUp(settingsEnv(home)), (report) => { socket.emit('agents:found', report); });
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

  it('records a machine\'s reports in the order it sent them, so an older one never lands over a newer', async () => {
    const db: MongoDB = await testDatabase();
    await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: new Date().toISOString() });
    let releaseFirst: () => void = () => undefined;
    const recorded: unknown[] = [];
    const machines = {
      seen: async () => undefined, recordAgentBundle: async () => undefined, currentBundle: async () => undefined, recordAgentUpdate: async () => undefined, manualAgents: async () => [],
      recordAgents: async (_deviceId: string, report: unknown) => {
        recorded.push(report);
        if (recorded.length === 1) await new Promise<void>((done) => { releaseFirst = done; });
      },
    } as unknown as Pick<MachineService, 'seen' | 'recordAgents' | 'manualAgents' | 'recordAgentBundle' | 'recordAgentUpdate' | 'currentBundle'>;
    const { io, url } = await wired(db, machines);
    let arrived = 0;
    io.of('/agent').on('connection', (socket) => { socket.on('agents:found', () => { arrived += 1; }); });
    const socket = await connected(url, 'desk');
    socket.emit('agents:found', { agents: [{ id: 'gemini', title: 'Gemini CLI', state: 'checking', source: 'found' }] });
    socket.emit('agents:found', { agents: [{ id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found' }] });
    await until(() => (arrived === 2 ? true : undefined));
    expect(recorded).toHaveLength(1);
    releaseFirst();
    await until(() => (recorded.length === 2 ? true : undefined));
    expect(recorded.map((report) => (report as { agents: { state: string }[] }).agents[0]!.state)).toEqual(['checking', 'ready']);
  });
});
