import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { followEngineWorker } from './device-worker-follow.js';
import type { DeviceWorker, DeviceWorkerOptions } from './engine-worker.js';
import { ExternalAgentSessions } from './external-agents.js';
import { IdleGate } from './idle-gate.js';
import { hostCluster } from './machine-cluster.js';
import type { EngineSettings } from './remote-blobs.js';

const socket = { on: () => undefined } as unknown as Socket;
const access = { token: async () => 'koala-token', freshToken: async () => 'koala-token', renewsAt: () => undefined };
const temporal = { address: '100.64.0.1:30322', namespace: 'default', ca: 'the-ca', serverName: 'temporal.koala' };
const settings = (more: Partial<EngineSettings> = {}): EngineSettings => ({ ring: { current: 'payload-key-0123456789abcdef' } as never, temporal, ...more });

const following = () => {
  const handed: DeviceWorkerOptions[] = [];
  const gate = new IdleGate();
  const sessions = new ExternalAgentSessions({ rootDir: '/home/person/koala', launches: {}, gate });
  let ended: () => void = () => undefined;
  const worker = { run: () => new Promise<void>((resolve) => { ended = resolve; }), shutdown: () => ended(), getState: () => 'RUNNING', setToken: async () => undefined } as unknown as DeviceWorker;
  const host = followEngineWorker(socket, { deviceId: 'desk', rootDir: '/home/person/koala' } as never, { url: 'http://koala.test', resource: 'urn:koala:instance:desk', access }, sessions, gate, hostCluster(async () => undefined), async (options) => { handed.push(options); return worker; });
  return { host: host!, handed };
};

describe('starting the device worker from what Koala answers', () => {
  it('starts it for this machine\'s device at the Temporal Koala names, over its TLS, with the token root gave for this Koala', async () => {
    const { host, handed } = following();
    await host.connected(async () => settings());
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ deviceId: 'desk', rootDir: '/home/person/koala', address: '100.64.0.1:30322', namespace: 'default', tls: { ca: 'the-ca', serverName: 'temporal.koala' }, token: 'koala-token' });
    expect(host.fingerprint).toBeDefined();
    await host.stop();
  });

  it('starts nothing when Koala names no Temporal for this machine', async () => {
    const { host, handed } = following();
    await host.connected(async () => settings({ temporal: undefined }));
    expect(handed).toEqual([]);
    expect(host.fingerprint).toBeUndefined();
    await host.stop();
  });
});
