import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { temporal } from '@temporalio/proto';
import type { Socket } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { WORK_TOKEN_ENDED } from '@koala/engine-core/machine-join';
import { startWork, type AgentPlace } from './agent-work.js';
import { deviceQueue, startDeviceWorker } from './engine-worker.js';
import type { ClusterHost } from './machine-cluster.js';
import { koalaAnsweringPayloads, temporalBehindTls } from './testing/temporal-world.js';

const world = temporalBehindTls('koala-agent-work-');

const noKoalaK3s: ClusterHost = {
  platform: 'linux',
  run: async (file) => {
    if (file === 'nvidia-smi') return 'NVIDIA GeForce RTX 3090, 24576\n';
    if (file === 'lspci') return 'Slot:\t01:00.0\nClass:\tVGA compatible controller [0300]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tGA102 [GeForce RTX 3090] [2204]\nDriver:\tnvidia\n';
    throw Object.assign(new Error(`spawn ${file} ENOENT: this computer has no ${file}`), { code: 'ENOENT' });
  },
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

describe('the machine agent starting its work for its Koala', () => {
  it('connects to its Koala with its work token, reports its agents, its cluster and its GPUs, and starts its device worker, which polls the machine\'s queue', async () => {
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

    const work = startWork(place, { rootUrl: 'http://127.0.0.1:1', token: 'device', rootDir: world.rootDir, deviceId: 'work-desk' }, `http://127.0.0.1:${port}`, 'work-token', () => undefined, () => undefined);
    expect(work.url).toBe(`http://127.0.0.1:${port}`);

    const pollers = async () => (await world.env.client.workflowService.describeTaskQueue({
      namespace: 'default', taskQueue: { name: deviceQueue('work-desk') }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0 || heard.agents === undefined || heard.cluster === undefined) await new Promise((done) => setTimeout(done, 100));
    expect(heard).toMatchObject({ token: 'work-token', agents: { agents: [] }, cluster: { state: 'absent', gpus: [{ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 1, runtime: false }], problems: [], withoutDriver: [] } });
    expect(stops).toHaveLength(1);
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });

  it('asks root for a new work token when its Koala cuts it off because the token ran out, and connects again with the one it is given', async () => {
    const tokens: string[] = [];
    let cut: (asked: number) => void = () => undefined;
    const firstCut = new Promise<number>((done) => { cut = done; });
    let asked = 0;
    const { koala, port } = await koalaAnsweringPayloads(world, {
      at: '/agent',
      key: 'agent-work-ended-key-0123456789abcdef',
      connected: (socket) => {
        tokens.push((socket.handshake.auth as { token?: string }).token ?? '');
        if (tokens.length > 1) return;
        socket.emit(WORK_TOKEN_ENDED, { said: 'this machine\'s work token expired' });
        void socket.emitWithAck('sandbox:exec', { leafId: 'probe', command: 'true' }).then(() => {
          cut(asked);
          socket.disconnect(true);
        });
      },
    });
    const work = startWork(placeHere([]), { rootUrl: 'http://127.0.0.1:1', token: 'device', rootDir: world.rootDir, deviceId: 'ended-desk' }, `http://127.0.0.1:${port}`, 'old-token', () => { asked += 1; }, () => undefined);
    expect(await firstCut).toBe(1);
    await work.setToken('new-token');
    while (tokens.length < 2) await new Promise((done) => setTimeout(done, 50));
    expect(tokens).toEqual(['old-token', 'new-token']);
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });

  it('runs a command its Koala sends in the folder it names under the machine\'s own folder, and answers what the command printed and how it ended', async () => {
    const sockets: Socket[] = [];
    const { koala, port } = await koalaAnsweringPayloads(world, { at: '/agent', key: 'agent-work-exec-key-0123456789abcdef', connected: (socket) => { sockets.push(socket); } });
    await mkdir(path.join(world.rootDir, 'project'), { recursive: true });
    startWork(placeHere([]), { rootUrl: 'http://127.0.0.1:1', token: 'device', rootDir: world.rootDir, deviceId: 'exec-desk' }, `http://127.0.0.1:${port}`, 'exec-token', () => undefined, () => undefined);
    while (sockets.length === 0) await new Promise((done) => setTimeout(done, 50));
    const ran = await sockets[0]!.emitWithAck('sandbox:exec', { leafId: 'leaf-1', command: 'pwd; echo a warning >&2; exit 3', cwd: 'project' }) as Record<string, unknown>;
    expect(ran).toMatchObject({ stdout: `${await realpath(path.join(world.rootDir, 'project'))}\n`, stderr: 'a warning\n', exitCode: 3, timedOut: false });
    const escaped = await sockets[0]!.emitWithAck('sandbox:exec', { leafId: 'leaf-1', command: 'pwd', cwd: '../elsewhere' }) as Record<string, unknown>;
    expect(escaped.exitCode).not.toBe(0);
    expect(String(escaped.stderr)).toContain('escapes the root directory');
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });
});
