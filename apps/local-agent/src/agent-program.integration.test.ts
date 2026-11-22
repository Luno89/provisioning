import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type RequestListener, type Server as HttpServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { temporal } from '@temporalio/proto';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { koalaInstallProgressPath, PLACE_KOALA, STOP_KOALA } from '@koala/engine-core/koala-install';
import { deviceQueue } from './engine-worker.js';
import { startTestTemporal, type TestTemporal, type TestTemporalServer } from '@koala/engine-core/testing/temporal';
import { makeCertificates, type TestCertificates } from '@koala/engine-core/testing/temporal-tls';
import { clientKeysFrom, newClientKey } from '@koala/engine-core/root-client';
import { rootRegistration, type RootRegistration } from './testing/root-registration.js';

const MACHINE_KEY = newClientKey();
const AGENT = path.join(import.meta.dirname, '..');
const ENTRY = path.join(import.meta.dirname, 'index.ts');

let server: TestTemporalServer;
let env: TestTemporal;
let home: string;
let certificates: TestCertificates;
let front: { address: string };
const servers: HttpServer[] = [];

beforeAll(async () => {
  certificates = makeCertificates();
  server = await startTestTemporal(certificates);
  env = server.env;
  front = { address: server.tlsAddress };
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-agent-program-'));
});

afterAll(async () => {
  for (const server of servers) server.close();
  await server.close();
  await fs.rm(home, { recursive: true, force: true });
});

const listening = async (handler?: RequestListener): Promise<{ io: Server; url: string }> => {
  const http = handler ? createServer(handler) : createServer();
  servers.push(http);
  const io = new Server(http);
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  return { io, url: `http://127.0.0.1:${(http.address() as { port: number }).port}` };
};

const exited = (child: ChildProcess): Promise<number | null> => new Promise((done) => child.once('exit', (code) => done(code)));

interface RootPlacingKoala {
  rootUrl: string;
  reports: Array<{ progress: Record<string, unknown>; auth: string | undefined }>;
  toRoot: Array<{ emit(event: string, payload?: unknown): void }>;
}

const registeredDesk = (): RootRegistration => {
  const registration = rootRegistration();
  registration.registered.push({ clientId: 'program-desk', code: 'joined-before', keys: [{ kid: clientKeysFrom(MACHINE_KEY).kid }] });
  return registration;
};

const answeredBy = (registration: RootRegistration, rootUrl: () => string, otherwise: (req: IncomingMessage, res: ServerResponse, body: string) => void): RequestListener => (req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => void registration.answer(new Request(`${rootUrl()}${req.url}`, { method: req.method ?? 'GET', headers: req.headers as Record<string, string>, ...(req.method === 'POST' ? { body } : {}) })).then(async (answered) => {
    if (!answered) return otherwise(req, res, body);
    res.writeHead(answered.status, { 'content-type': answered.headers.get('content-type') ?? 'application/json' }).end(await answered.text());
  }));
};

const rootPlacingKoala = async (installId: string, answers: (req: IncomingMessage, res: ServerResponse) => boolean = () => false): Promise<RootPlacingKoala> => {
  const reports: RootPlacingKoala['reports'] = [];
  let rootUrl = '';
  const http = createServer(answeredBy(registeredDesk(), () => rootUrl, (req, res, body) => {
    if (req.method === 'POST' && req.url === koalaInstallProgressPath(installId)) {
      reports.push({ progress: JSON.parse(body) as Record<string, unknown>, auth: req.headers.authorization });
      res.writeHead(204).end();
      return;
    }
    if (answers(req, res)) return;
    res.writeHead(404).end('not here');
  }));
  servers.push(http);
  const io = new Server(http);
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  rootUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const toRoot: RootPlacingKoala['toRoot'] = [];
  io.of('/machine-account').on('connection', (socket) => {
    toRoot.push(socket);
    socket.emit(PLACE_KOALA, {
      installId, instanceId: 'program-koala', ownerId: 'bo', machineId: 'program-desk', rootUrl, rootPublicKeys: 'PEM', meshLoginServer: 'https://mesh.koala.test',
      meshAddress: '100.64.0.7', image: 'nowrinkles/app', imageTag: 'v1', chartUrl: `${rootUrl}/api/instances/chart/v1.tgz`, registrationCode: 'program-registration-code',
    });
  });
  return { rootUrl, reports, toRoot };
};

describe('the machine agent\'s own program, on a computer that is only a throwaway home', () => {
  it('reads its machine.json, connects to root, works for the Koala root names, and stops on SIGTERM', async () => {
    const koala = await listening();
    let rootUrl = '';
    const root = await listening(answeredBy(registeredDesk(), () => rootUrl, (_req, res) => { res.writeHead(404).end('not here'); }));
    rootUrl = root.url;
    const heard: Record<string, unknown> = {};
    const toRoot: Array<{ emit(event: string, payload: unknown): void }> = [];
    root.io.of('/machine-account').on('connection', (socket) => {
      toRoot.push(socket);
      heard.rootToken = (socket.handshake.auth as { token?: string }).token;
      socket.emit('machine:koala', { url: koala.url, workToken: 'program-work-token' });
    });
    koala.io.of('/agent').on('connection', (socket) => {
      heard.workToken = (socket.handshake.auth as { token?: string }).token;
      socket.on('agents:manual', (_payload: unknown, ack: (answer: unknown) => void) => ack({ agents: [] }));
      socket.on('agents:found', (found: unknown) => { heard.agents = found; });
      socket.on('machine:payloads', (_payload: unknown, ack: (answer: unknown) => void) => {
        ack({ ring: { current: 'agent-program-payload-key-0123456789ab' }, temporal: { address: front.address, namespace: 'default', ca: certificates.ca, serverName: certificates.serverName } });
      });
    });
    const rootDir = path.join(home, 'koala');
    await fs.mkdir(path.join(home, '.config', 'koala'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'koala', 'machine.json'), JSON.stringify({ rootUrl: root.url, token: 'program-device-token', rootDir, deviceId: 'program-desk', key: MACHINE_KEY }), { mode: 0o600 });

    const bin = path.join(home, 'bin');
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\necho inactive\n', { mode: 0o755 });

    const said: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      cwd: AGENT,
      env: {
        HOME: home,
        PATH: bin,
        TMPDIR: os.tmpdir(),
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => said.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => said.push(chunk.toString()));
    const ended = exited(child);

    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: 'default', taskQueue: { name: deviceQueue('program-desk') }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while (child.exitCode === null && !said.join('').includes('could not start') && ((await pollers()).length === 0 || heard.agents === undefined)) await new Promise((done) => setTimeout(done, 100));
    expect(child.exitCode, said.join('')).toBeNull();
    expect(said.join('')).not.toContain('could not start');
    expect(heard).toMatchObject({ rootToken: 'token-for-program-desk', workToken: 'program-work-token', agents: { agents: [] } });

    toRoot[0]!.emit('machine:koala', { url: koala.url, workToken: 'program-work-token-2' });
    while (child.exitCode === null && !said.join('').includes('took a new work token')) await new Promise((done) => setTimeout(done, 100));
    expect(child.exitCode, said.join('')).toBeNull();
    for (const socket of koala.io.of('/agent').sockets.values()) socket.conn.close();
    while (child.exitCode === null && heard.workToken !== 'program-work-token-2') await new Promise((done) => setTimeout(done, 100));
    expect(child.exitCode, said.join('')).toBeNull();

    child.kill('SIGTERM');
    expect(await ended).toBe(0);
  });
});

const program = async (args: string[], extra: Record<string, string> = {}) => {
  const place = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-agent-place-'));
  const machineRoot = path.join(place, 'machine');
  const bin = path.join(place, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  await fs.writeFile(path.join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 });
  const said: string[] = [];
  const start = () => {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
      cwd: AGENT,
      env: {
        HOME: place,
        PATH: bin,
        TMPDIR: os.tmpdir(),
        KOALA_MACHINE_ROOT: machineRoot,
        ...extra,
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => said.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => said.push(chunk.toString()));
    return child;
  };
  const onMachine = (file: string) => path.join(machineRoot, file);
  const machineFile = path.join(place, '.config', 'koala', 'machine.json');
  const serviceFile = path.join(place, '.config', 'systemd', 'user', 'koala-machine.service');
  const joined = async (rootUrl: string) => {
    await fs.mkdir(path.dirname(machineFile), { recursive: true });
    await fs.writeFile(machineFile, JSON.stringify({ rootUrl, token: 'program-device-token', rootDir: path.join(place, 'koala'), deviceId: 'program-desk', key: MACHINE_KEY }), { mode: 0o600 });
    await fs.mkdir(path.dirname(serviceFile), { recursive: true });
    await fs.writeFile(serviceFile, '[Service]\n');
  };
  const k3sInstalled = async (uninstall: string) => {
    await fs.mkdir(path.dirname(onMachine('/etc/koala/machine-k3s')), { recursive: true });
    await fs.writeFile(onMachine('/etc/koala/machine-k3s'), '');
    await fs.mkdir(path.dirname(onMachine('/usr/local/lib/koala/machine-uninstall.sh')), { recursive: true });
    await fs.writeFile(onMachine('/usr/local/lib/koala/machine-uninstall.sh'), `#!/bin/sh\n${uninstall}\n`, { mode: 0o755 });
  };
  const there = (file: string) => fs.access(file).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; });
  return { start, said, bin, onMachine, machineFile, serviceFile, joined, k3sInstalled, there };
};

describe('removing this machine, as the agent\'s own program does it, on a throwaway home and machine', () => {
  it('uninstalls Koala\'s k3s, deletes its token and service file, and says so', async () => {
    const here = await program(['remove']);
    await here.joined('http://127.0.0.1:1');
    await here.k3sInstalled(`/bin/rm -f "${here.onMachine('/etc/koala/machine-k3s')}" "$0"`);
    expect(await exited(here.start()), here.said.join('')).toBe(0);
    expect(here.said.join('')).toContain('k3s and everything Koala ran on it are removed from this machine');
    expect(await here.there(here.onMachine('/usr/local/lib/koala/machine-uninstall.sh'))).toBe(false);
    expect(await here.there(here.machineFile)).toBe(false);
    expect(await here.there(here.serviceFile)).toBe(false);
  });

  it('still deletes its token, and fails saying so, when k3s is left on the machine', async () => {
    const here = await program(['remove']);
    await here.joined('http://127.0.0.1:1');
    await here.k3sInstalled('exit 0');
    expect(await exited(here.start())).toBe(1);
    expect(here.said.join('')).toContain('k3s is still on this machine: /usr/local/lib/koala/machine-uninstall.sh did not remove it');
    expect(await here.there(here.machineFile)).toBe(false);
  });
});

describe('Koala placed on this machine by root, as the agent\'s own program takes it, on a machine without Koala\'s k3s', () => {
  it('tells root the stage it is at on the install root asked for, with its own token, then where and why it failed, and removes itself when root removes the machine', async () => {
    const { rootUrl, reports, toRoot } = await rootPlacingKoala('program-install');
    const here = await program([]);
    await here.joined(rootUrl);
    const child = here.start();
    while (!reports.some((report) => report.progress.state === 'failed') && child.exitCode === null) await new Promise((done) => setTimeout(done, 100));
    expect(reports, here.said.join('')).toEqual([
      { progress: { stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'started' }, auth: 'Bearer token-for-program-desk' },
      { progress: { stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'failed', why: 'k3s is not installed on this machine; run the command from My Machines again to install it' }, auth: 'Bearer token-for-program-desk' },
    ]);
    const ended = exited(child);
    toRoot[0]!.emit('machine:removed');
    expect(await ended, here.said.join('')).toBe(0);
    expect(await here.there(here.machineFile)).toBe(false);
  });
});

describe('Koala placed on this machine by root and then stopped by root, as the agent\'s own program takes it', () => {
  it('stops fetching the chart the moment root says the install is stopped, tells root nothing more, says it stopped, and keeps running', async () => {
    const hanging: Array<{ end(): void }> = [];
    const { rootUrl, reports, toRoot } = await rootPlacingKoala('program-stopped', (req, res) => {
      if (req.url !== '/api/instances/chart/v1.tgz') return false;
      hanging.push(res);
      return true;
    });
    const here = await program([]);
    await here.joined(rootUrl);
    await here.k3sInstalled('exit 0');
    await fs.writeFile(path.join(here.bin, 'systemctl'), '#!/bin/sh\necho active\n', { mode: 0o755 });
    const child = here.start();
    try {
      while (hanging.length === 0 && child.exitCode === null) await new Promise((done) => setTimeout(done, 100));
      expect(child.exitCode, here.said.join('')).toBeNull();
      toRoot[0]!.emit(STOP_KOALA, { installId: 'program-stopped' });
      while (!here.said.join('').includes('Putting Koala on this machine stopped: root stopped it before it finished') && child.exitCode === null) await new Promise((done) => setTimeout(done, 100));
      expect(reports.map(({ progress }) => `${String(progress.stage)} ${String(progress.state)}`), here.said.join('')).toEqual(['cluster started', 'cluster already-done', 'chart started']);
      expect(child.exitCode, here.said.join('')).toBeNull();
      const ended = exited(child);
      toRoot[0]!.emit('machine:removed');
      expect(await ended, here.said.join('')).toBe(0);
    } finally {
      for (const res of hanging) res.end();
      if (child.exitCode === null) {
        const ended = exited(child);
        child.kill('SIGTERM');
        await ended;
      }
    }
  });
});
