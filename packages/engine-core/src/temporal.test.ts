import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { CompressionCodec, EncryptionCodec, type BlobReach } from './payload-codec.js';
import { WORKER_DEFAULTS } from './liveness.js';
import { connectTemporal, createClient, createWorker, replayHistory } from './temporal.js';

vi.mock('@temporalio/worker', () => ({
  Worker: { create: vi.fn(async (options: unknown) => ({ options })), runReplayHistory: vi.fn(async () => undefined) },
  NativeConnection: { connect: vi.fn(async () => ({ setApiKey: vi.fn(async () => undefined) })) },
}));

vi.mock('@temporalio/client', () => ({
  Client: vi.fn(function Client(this: { options: unknown }, options: unknown) { this.options = options; }),
  Connection: { lazy: vi.fn(() => ({ ensureConnected: vi.fn(async () => undefined), close: vi.fn(async () => undefined) })) },
}));

const payloads = { ring: { current: 'a-payload-key-for-the-unit-tier' }, blobs: ({ put: async () => undefined, get: async () => new Map() } satisfies BlobReach) };
const CA = '-----BEGIN CERTIFICATE-----\nthe install\'s own CA\n-----END CERTIFICATE-----\n';

const codecsOf = (converter: { payloadCodecs?: unknown[] } | undefined): unknown[] => (converter?.payloadCodecs ?? []).map((codec) => (codec as object).constructor);

beforeEach(() => { vi.clearAllMocks(); });

describe('a worker Koala builds', () => {
  it('compresses and then seals every payload it sends, and keeps large ones outside Temporal', async () => {
    await createWorker({ connection: ({} as NativeConnection), namespace: 'default', taskQueue: 'q', payloads, activities: {} });
    const options = vi.mocked(Worker.create).mock.calls[0]?.[0];
    expect(codecsOf(options?.dataConverter)).toEqual([CompressionCodec, EncryptionCodec]);
    expect(options?.dataConverter?.externalStorage?.drivers.map((driver) => driver.name)).toEqual(['blobs']);
  });

  it('notices a stop within the shared window and runs every activity through the shared interceptors', async () => {
    await createWorker({ connection: ({} as NativeConnection), namespace: 'default', taskQueue: 'q', payloads, workflowModules: ['/the/telemetry.ts'] });
    const options = vi.mocked(Worker.create).mock.calls[0]?.[0];
    expect(options?.maxHeartbeatThrottleInterval).toBe(WORKER_DEFAULTS.maxHeartbeatThrottleInterval);
    expect(options?.interceptors?.activity).toHaveLength(4);
    expect(options?.interceptors?.workflowModules).toEqual(['/the/telemetry.ts']);
  });

  it('tells whoever asked when a payload it was handed can never be read, and still refuses it', async () => {
    const heard: string[] = [];
    await createWorker({ connection: ({} as NativeConnection), namespace: 'default', taskQueue: 'q', payloads, onUnreadable: (why) => heard.push(why.message) });
    const codecs = vi.mocked(Worker.create).mock.calls[0]?.[0]?.dataConverter?.payloadCodecs ?? [];
    const plain = [{ metadata: { encoding: Buffer.from('json/plain') }, data: Buffer.from('"in the clear"') }];
    let decoding = Promise.resolve(plain) as Promise<unknown>;
    for (const codec of [...codecs].reverse()) decoding = decoding.then((given) => codec.decode(given as typeof plain));
    await expect(decoding).rejects.toThrow(/arrived unencrypted/);
    expect(heard).toEqual([expect.stringMatching(/arrived unencrypted/)]);
  });

  it('cannot be built without the key that seals its payloads', async () => {
    await expect(createWorker({ connection: ({} as NativeConnection), namespace: 'default', taskQueue: 'q', payloads: { ring: { current: '' }, blobs: payloads.blobs } })).rejects.toThrow(/requires a master key/);
    expect(Worker.create).not.toHaveBeenCalled();
  });

  it('replays a recorded history through the same seal it was written with', async () => {
    await replayHistory({ workflowsPath: '/the/workflows.ts' }, { events: [] }, payloads);
    const options = vi.mocked(Worker.runReplayHistory).mock.calls[0]?.[0];
    expect(codecsOf(options?.dataConverter)).toEqual([CompressionCodec, EncryptionCodec]);
  });
});

describe('a client Koala builds', () => {
  it('seals what it sends with the same converter its workers read with', () => {
    const client = createClient({ connection: ({} as Connection), namespace: 'n', payloads }) as unknown as { options: { dataConverter: { payloadCodecs: unknown[] } } };
    expect(Client).toHaveBeenCalledOnce();
    expect(codecsOf(client.options.dataConverter)).toEqual([CompressionCodec, EncryptionCodec]);
  });

  it('cannot be built without the key that seals its payloads', () => {
    expect(() => createClient({ connection: ({} as Connection), namespace: 'n', payloads: { ring: '', blobs: payloads.blobs } })).toThrow(/requires a master key/);
  });
});

describe('dialling Temporal', () => {
  it('reaches it over TLS to the install\'s own CA with a signed key, on the client side', async () => {
    const apiKey = () => 'a-signed-key';
    await connectTemporal({ address: 'temporal:7233', tls: { ca: CA }, auth: { apiKey, renewEveryMs: 1_000 } }, 'client');
    const options = vi.mocked(Connection.lazy).mock.calls[0]?.[0];
    expect(options?.address).toBe('temporal:7233');
    expect(options?.tls).toEqual({ serverRootCACertificate: Buffer.from(CA) });
    expect(options?.apiKey).toBe(apiKey);
  });

  it('leaves no connection behind when Temporal could not be reached, on the client side', async () => {
    const opened = { ensureConnected: vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7233'); }), close: vi.fn(async () => undefined) };
    vi.mocked(Connection.lazy).mockReturnValueOnce(opened as unknown as Connection);
    await expect(connectTemporal({ address: 'temporal:7233', tls: { ca: CA }, auth: { bearer: 't' } }, 'client')).rejects.toThrow(/ECONNREFUSED/);
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it('reaches it over TLS to the install\'s own CA with a signed key it renews, on the worker side', async () => {
    vi.useFakeTimers();
    try {
      let issued = 0;
      const connection = await connectTemporal({ address: 'temporal:7233', tls: { ca: CA, serverName: 'temporal' }, auth: { apiKey: () => `key-${++issued}`, renewEveryMs: 1_000 } }, 'worker');
      const options = vi.mocked(NativeConnection.connect).mock.calls[0]?.[0];
      expect(options?.tls).toEqual({ serverRootCACertificate: Buffer.from(CA), serverNameOverride: 'temporal' });
      expect(options?.apiKey).toBe('key-1');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connection.setApiKey).toHaveBeenCalledWith('key-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries a machine\'s bearer token instead of a key, still over TLS', async () => {
    await connectTemporal({ address: 'gateway:443', tls: { ca: CA }, auth: { bearer: 'device-token' } }, 'worker');
    const options = vi.mocked(NativeConnection.connect).mock.calls[0]?.[0];
    expect(options?.metadata).toEqual({ authorization: 'Bearer device-token' });
    expect(options?.tls).toEqual({ serverRootCACertificate: Buffer.from(CA) });
  });

  it('refuses to dial without the install\'s CA, so nothing talks to Temporal in plaintext', async () => {
    await expect(connectTemporal({ address: 'temporal:7233', tls: { ca: '' }, auth: { bearer: 't' } }, 'worker')).rejects.toThrow(/never talks to Temporal in plaintext/);
    expect(NativeConnection.connect).not.toHaveBeenCalled();
  });
});
