import fs from 'fs/promises';
import { createServer } from 'node:http';
import os from 'os';
import path from 'path';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followEngineWorker } from './device-worker-follow.js';
import { deviceQueue } from './engine-worker.js';
import { ExternalAgentSessions } from './external-agents.js';
import { IdleGate } from './idle-gate.js';
import { LocalMcpServer } from './local-mcp.js';
import { hostCluster } from './machine-cluster.js';

let env: TestWorkflowEnvironment;
let rootDir: string;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-follow-'));
});

afterAll(async () => {
  await env.teardown();
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('the machine agent following its Koala for its device worker', () => {
  it('asks Koala over its socket where Temporal is and for the payload keys, then starts the device worker, which polls this machine\'s queue', async () => {
    const http = createServer();
    const koala = new Server(http);
    const asked: string[] = [];
    koala.on('connection', (socket) => {
      socket.on('machine:payloads', (_payload: unknown, ack: (answer: unknown) => void) => {
        asked.push('machine:payloads');
        ack({ ring: { current: 'follow-payload-key-0123456789abcdef' }, temporal: { address: env.address, namespace: 'default' } });
      });
    });
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    const { port } = http.address() as { port: number };
    const socket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const gate = new IdleGate();
    const sessions = new ExternalAgentSessions({ rootDir, launches: {}, mcp: new LocalMcpServer({ log: () => undefined }), gate });
    const host = followEngineWorker(socket, { deviceId: 'follow-desk', rootDir } as never, `http://127.0.0.1:${port}`, { value: 'work-token' }, sessions, gate, hostCluster(async () => undefined));
    expect(host).toBeDefined();

    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: 'default', taskQueue: { name: deviceQueue('follow-desk') }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    expect(asked).toEqual(['machine:payloads']);

    await host!.stop();
    socket.close();
    await new Promise<void>((done) => { void koala.close(() => done()); });
  }, 120_000);

  it('follows nothing on a machine that has not joined, having no device', () => {
    const gate = new IdleGate();
    const socket = connect('http://127.0.0.1:1', { autoConnect: false });
    const sessions = new ExternalAgentSessions({ rootDir, launches: {}, mcp: new LocalMcpServer({ log: () => undefined }), gate });
    expect(followEngineWorker(socket, { rootDir } as never, 'http://127.0.0.1:1', { value: '' }, sessions, gate, hostCluster(async () => undefined))).toBeUndefined();
  });
});
