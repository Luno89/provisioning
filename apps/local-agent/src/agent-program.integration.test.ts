import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceQueue } from './engine-worker.js';

const AGENT = path.join(import.meta.dirname, '..');
const ENTRY = path.join(import.meta.dirname, 'index.ts');

let env: TestWorkflowEnvironment;
let home: string;
const servers: HttpServer[] = [];

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-agent-program-'));
});

afterAll(async () => {
  for (const server of servers) server.close();
  await env.teardown();
  await fs.rm(home, { recursive: true, force: true });
});

const listening = async (): Promise<{ io: Server; url: string }> => {
  const http = createServer();
  servers.push(http);
  const io = new Server(http);
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  return { io, url: `http://127.0.0.1:${(http.address() as { port: number }).port}` };
};

const exited = (child: ChildProcess): Promise<number | null> => new Promise((done) => child.once('exit', (code) => done(code)));

describe('the machine agent\'s own program, on a computer that is only a throwaway home', () => {
  it('reads its machine.json, connects to root, works for the Koala root names, and stops on SIGTERM', async () => {
    const koala = await listening();
    const root = await listening();
    const heard: Record<string, unknown> = {};
    const toRoot: Array<{ emit(event: string, payload: unknown): void }> = [];
    root.io.of('/machine-account').on('connection', (socket) => {
      toRoot.push(socket);
      heard.deviceToken = (socket.handshake.auth as { token?: string }).token;
      socket.emit('machine:koala', { url: koala.url, workToken: 'program-work-token' });
    });
    koala.io.of('/agent').on('connection', (socket) => {
      heard.workToken = (socket.handshake.auth as { token?: string }).token;
      socket.on('agents:manual', (_payload: unknown, ack: (answer: unknown) => void) => ack({ agents: [] }));
      socket.on('agents:found', (found: unknown) => { heard.agents = found; });
      socket.on('machine:payloads', (_payload: unknown, ack: (answer: unknown) => void) => {
        ack({ ring: { current: 'agent-program-payload-key-0123456789ab' }, temporal: { address: env.address, namespace: 'default' } });
      });
    });
    const rootDir = path.join(home, 'koala');
    await fs.mkdir(path.join(home, '.config', 'koala'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'koala', 'machine.json'), JSON.stringify({ rootUrl: root.url, token: 'program-device-token', rootDir, deviceId: 'program-desk' }), { mode: 0o600 });

    const bin = path.join(home, 'bin');
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, path.join(bin, 'node'));

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
    while (child.exitCode === null && ((await pollers()).length === 0 || heard.agents === undefined)) await new Promise((done) => setTimeout(done, 100));
    expect(child.exitCode, said.join('')).toBeNull();
    expect(heard).toMatchObject({ deviceToken: 'program-device-token', workToken: 'program-work-token', agents: { agents: [] } });

    toRoot[0]!.emit('machine:koala', { url: koala.url, workToken: 'program-work-token-2' });
    while (!said.join('').includes('took a new work token')) await new Promise((done) => setTimeout(done, 100));
    for (const socket of koala.io.of('/agent').sockets.values()) socket.conn.close();
    while (heard.workToken !== 'program-work-token-2') await new Promise((done) => setTimeout(done, 100));

    child.kill('SIGTERM');
    expect(await ended).toBe(0);
  }, 120_000);
});
