import { temporal } from '@temporalio/proto';
import { io as connect } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { koalaAnsweringPayloads, temporalBehindTls } from './testing/temporal-world.js';
import { followEngineWorker } from './device-worker-follow.js';
import { createDeviceActivities, deviceQueue, startDeviceWorker, type DeviceWorkerOptions } from './engine-worker.js';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ExternalAgentSessions } from './external-agents.js';
import { IdleGate } from './idle-gate.js';
import { LocalMcpServer } from './local-mcp.js';
import { hostCluster, type MachineHost } from './machine-cluster.js';

const world = temporalBehindTls('koala-follow-');

describe('the machine agent following its Koala for its device worker', () => {
  it('asks Koala over its socket where Temporal is and for the payload keys, then starts the device worker, which polls this machine\'s queue', async () => {
    const asked: string[] = [];
    const { koala, port } = await koalaAnsweringPayloads(world, { at: '/', key: 'follow-payload-key-0123456789abcdef', asked: () => asked.push('machine:payloads') });
    const socket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const gate = new IdleGate();
    const sessions = new ExternalAgentSessions({ rootDir: world.rootDir, launches: {}, mcp: new LocalMcpServer({ log: () => undefined }), gate });
    const handed: DeviceWorkerOptions[] = [];
    const noKoalaK3s: MachineHost = { ...hostCluster(async () => undefined), exists: async () => false };
    const host = followEngineWorker(socket, { deviceId: 'follow-desk', rootDir: world.rootDir } as never, { url: `http://127.0.0.1:${port}`, resource: 'urn:koala:instance:follow', access: { token: async () => 'koala-token', freshToken: async () => 'koala-token', renewsAt: () => Date.now() + 60 * 60 * 1000 } }, sessions, gate, noKoalaK3s, (options) => { handed.push(options); return startDeviceWorker(options); });
    expect(host).toBeDefined();

    const pollers = async () => (await world.env.client.workflowService.describeTaskQueue({
      namespace: 'default', taskQueue: { name: deviceQueue('follow-desk') }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    expect(asked).toEqual(['machine:payloads']);
    const { MachineClusterActivity } = createDeviceActivities(handed[0]!);
    const activity = new MockActivityEnvironment();
    expect(await activity.run(MachineClusterActivity, { kind: 'stop' as const })).toEqual({ state: 'absent' });
    await expect(activity.run(MachineClusterActivity, { kind: 'start' as const })).rejects.toThrow(/k3s is not installed on this machine/);

    await host!.stop();
    socket.close();
    await new Promise<void>((done) => { void koala.close(() => done()); });
  });

  it('follows nothing on a machine that has not joined, having no device', () => {
    const gate = new IdleGate();
    const socket = connect('http://127.0.0.1:1', { autoConnect: false });
    const sessions = new ExternalAgentSessions({ rootDir: world.rootDir, launches: {}, mcp: new LocalMcpServer({ log: () => undefined }), gate });
    expect(followEngineWorker(socket, { rootDir: world.rootDir } as never, { url: 'http://127.0.0.1:1', resource: 'urn:koala:instance:follow', access: { token: async () => '', freshToken: async () => '', renewsAt: () => undefined } }, sessions, gate, hostCluster(async () => undefined), startDeviceWorker)).toBeUndefined();
  });
});
