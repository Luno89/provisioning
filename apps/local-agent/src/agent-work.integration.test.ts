import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { temporal } from '@temporalio/proto';
import type { Socket } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { MACHINE_CLIENT_TOKEN } from '@koala/engine-core/machine-join';
import { startWork, type AgentPlace } from './agent-work.js';
import { deviceQueue, startDeviceWorker } from './engine-worker.js';
import type { MachineHost } from './machine-cluster.js';
import { koalaAnsweringPayloads, temporalBehindTls } from './testing/temporal-world.js';

const made = vi.hoisted(() => ({ sockets: [] as ClientSocket[] }));
vi.mock('./koala-access.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./koala-access.js')>();
  return { ...real, koalaSocket: (...args: Parameters<typeof real.koalaSocket>) => { const socket = real.koalaSocket(...args); made.sockets.push(socket); return socket; } };
});

const world = temporalBehindTls('koala-agent-work-');

const noKoalaK3s: MachineHost = {
  platform: 'linux',
  run: async (file) => {
    if (file === 'nvidia-smi') return 'NVIDIA GeForce RTX 3090, 24576\n';
    if (file === 'lspci') return 'Slot:\t01:00.0\nClass:\tVGA compatible controller [0300]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tGA102 [GeForce RTX 3090] [2204]\nDriver:\tnvidia\n';
    throw Object.assign(new Error(`spawn ${file} ENOENT: this computer has no ${file}`), { code: 'ENOENT' });
  },
  follow: async (file) => { throw Object.assign(new Error(`spawn ${file} ENOENT: this computer has no ${file}`), { code: 'ENOENT' }); },
  exists: async () => false,
  read: async () => { throw new Error('nothing to read'); },
  list: async () => [],
  wanted: async () => undefined,
  isWanted: async () => false,
  holdKoala: async () => undefined,
  holdsKoala: async () => false,
  heldKoala: async () => undefined,
  letKoalaGo: async () => undefined,
  meshIp: async () => undefined,
  metricsClient: async () => undefined,
  now: () => Date.now(),
  pause: (ms) => new Promise((done) => setTimeout(done, ms)),
};

const placeHere = (stops: Array<() => void>): AgentPlace => ({
  agentDir: world.rootDir,
  ownBundle: 'bundle-sha',
  service: undefined,
  cluster: noKoalaK3s,
  discovery: () => ({ which: async () => undefined, exists: async () => false, probe: async () => { throw new Error('nothing to probe'); } }),
  agentsNotSetUp: async () => undefined,
  startDeviceWorker,
  onStop: (stop) => { stops.push(stop); },
  exit: () => undefined,
});

const RESOURCE = 'urn:koala:instance:inst-1';

function accessFromRoot() {
  let made = 0;
  let current = '';
  const asked: string[] = [];
  return {
    asked,
    rotate: () => { current = ''; },
    token: async (resource: string) => {
      asked.push(resource);
      if (!current) current = `access-${made += 1}`;
      return current;
    },
    freshToken: async (resource: string) => {
      asked.push(resource);
      current = `access-${made += 1}`;
      return current;
    },
    renewsAt: () => Date.now() + 60 * 60 * 1000,
  };
}

const koalaAt = (port: number) => ({ url: `http://127.0.0.1:${port}`, resource: RESOURCE });

describe('the machine agent starting its work for its Koala', () => {
  it('connects to its Koala with a token root gave it for its Koala, reports its agents, its cluster and its GPUs, and starts its device worker, which polls the machine\'s queue', async () => {
    const heard: Record<string, unknown> = {};
    const { koala, port } = await koalaAnsweringPayloads(world, {
      at: '/agent',
      key: 'agent-work-payload-key-0123456789abcdef',
      connected: (socket) => {
        heard.token = (socket.handshake.auth as { token?: string }).token;
        socket.on('agents:manual', (_payload: unknown, ack: (answer: unknown) => void) => ack({ agents: [] }));
        socket.on('agents:found', (found: unknown) => { heard.agents = found; });
        socket.on('machine:cluster', (state: unknown) => { heard.cluster = state; });
      },
    });
    const stops: Array<() => void> = [];
    const place = placeHere(stops);

    const access = accessFromRoot();
    const work = startWork(place, { rootUrl: 'http://127.0.0.1:1', rootDir: world.rootDir, deviceId: 'work-desk', key: 'unused-here' }, koalaAt(port), access, () => undefined);
    expect(work.url).toBe(`http://127.0.0.1:${port}`);

    const pollers = async () => (await world.env.client.workflowService.describeTaskQueue({
      namespace: 'default', taskQueue: { name: deviceQueue('work-desk') }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0 || heard.agents === undefined || heard.cluster === undefined) await new Promise((done) => setTimeout(done, 100));
    expect(access.asked.every((resource) => resource === RESOURCE)).toBe(true);
    expect(heard).toMatchObject({ token: 'access-1', agents: { agents: [] }, cluster: { state: 'absent', gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 1, runtime: false }], problems: [], withoutDriver: [] } });
    expect(stops).toHaveLength(1);
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });

  it('sends its Koala the fresh token root gives it before the first thing it sends once the one it holds changed, and connects again with a fresh one', async () => {
    const handshakes: string[] = [];
    const heard: string[] = [];
    const sockets: Socket[] = [];
    let manualAsked: () => void = () => undefined;
    const { koala, port } = await koalaAnsweringPayloads(world, {
      at: '/agent',
      key: 'agent-work-renewed-key-0123456789abcdef',
      connected: (socket) => {
        sockets.push(socket);
        handshakes.push((socket.handshake.auth as { token?: string }).token ?? '');
        socket.onAny((event: string, payload: { token?: string } | undefined) => { heard.push(event === MACHINE_CLIENT_TOKEN ? `token ${payload?.token ?? ''}` : event); });
        socket.on('agents:manual', (_payload: unknown, ack: (answer: unknown) => void) => {
          ack({ agents: [] });
          manualAsked();
        });
      },
    });
    const asked = () => new Promise<void>((done) => { manualAsked = done; });
    const access = accessFromRoot();
    const firstAsk = asked();
    startWork(placeHere([]), { rootUrl: 'http://127.0.0.1:1', rootDir: world.rootDir, deviceId: 'renewed-desk', key: 'unused-here' }, koalaAt(port), access, () => undefined);
    await firstAsk;
    expect(heard).not.toContain('token access-1');
    access.rotate();
    const secondAsk = asked();
    sockets[0]!.emit('agents:changed');
    await secondAsk;
    expect(heard.slice(heard.indexOf('token access-2'))[1]).toBe('agents:manual');
    const reconnected = asked();
    sockets[0]!.conn.close();
    await reconnected;
    expect(handshakes).toEqual(['access-1', 'access-3']);
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });

  it('asks its Koala again once root is back, after its Koala refused it while root could not give it a token', async () => {
    const handshakes: string[] = [];
    let connected: () => void = () => undefined;
    const { koala, port } = await koalaAnsweringPayloads(world, { at: '/agent', key: 'agent-work-again-key-0123456789abcdef', connected: () => connected() });
    koala.of('/agent').use((socket, next) => {
      const token = (socket.handshake.auth as { token?: string }).token;
      handshakes.push(token ?? '');
      next(token ? undefined : new Error('Unauthorized: send a token root gave this machine for this Koala'));
    });
    let rootAnswers = false;
    const access = { ...accessFromRoot(), freshToken: async () => { if (!rootAnswers) throw new Error('unexpected HTTP response status code'); return 'fresh'; } };
    const work = startWork(placeHere([]), { rootUrl: 'http://127.0.0.1:1', rootDir: world.rootDir, deviceId: 'again-desk', key: 'unused-here' }, koalaAt(port), access, () => undefined);
    const socket = made.sockets.at(-1)!;
    await new Promise<void>((refused) => socket.once('connect_error', () => refused()));
    expect(socket.active).toBe(false);
    rootAnswers = true;
    const back = new Promise<void>((done) => { connected = done; });
    work.again();
    await back;
    expect(handshakes).toEqual(['', 'fresh']);
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });

  it('runs a command its Koala sends in the folder it names under the machine\'s own folder, and answers what the command printed and how it ended', async () => {
    const sockets: Socket[] = [];
    const { koala, port } = await koalaAnsweringPayloads(world, { at: '/agent', key: 'agent-work-exec-key-0123456789abcdef', connected: (socket) => { sockets.push(socket); } });
    await mkdir(path.join(world.rootDir, 'project'), { recursive: true });
    startWork(placeHere([]), { rootUrl: 'http://127.0.0.1:1', rootDir: world.rootDir, deviceId: 'exec-desk', key: 'unused-here' }, koalaAt(port), accessFromRoot(), () => undefined);
    while (sockets.length === 0) await new Promise((done) => setTimeout(done, 50));
    const ran = await sockets[0]!.emitWithAck('sandbox:exec', { leafId: 'leaf-1', command: 'pwd; echo a warning >&2; exit 3', cwd: 'project' }) as Record<string, unknown>;
    expect(ran).toMatchObject({ stdout: `${await realpath(path.join(world.rootDir, 'project'))}\n`, stderr: 'a warning\n', exitCode: 3, timedOut: false });
    const escaped = await sockets[0]!.emitWithAck('sandbox:exec', { leafId: 'leaf-1', command: 'pwd', cwd: '../elsewhere' }) as Record<string, unknown>;
    expect(escaped.exitCode).not.toBe(0);
    expect(String(escaped.stderr)).toContain('escapes the root directory');
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });
});
