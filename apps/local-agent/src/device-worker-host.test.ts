import { describe, it, expect } from 'vitest';
import { DeviceWorkerHost, type RunningWorker } from './device-worker-host.js';

const fakeWorker = () => {
  let finish: () => void = () => {};
  const ran = new Promise<void>((resolve) => { finish = resolve; });
  const worker: RunningWorker & { stopped: boolean; end(): void } = {
    stopped: false,
    run: () => ran,
    shutdown() { worker.stopped = true; finish(); },
    end: () => finish(),
  };
  return worker;
};

describe('the machine\'s engine worker follows the payload key it is given', () => {
  it('starts once it has the key, and leaves a running worker alone when the key is the same', async () => {
    const started: ReturnType<typeof fakeWorker>[] = [];
    const host = new DeviceWorkerHost(async () => { const worker = fakeWorker(); started.push(worker); return worker; }, () => {});
    await host.connected(async () => ({ ring: { current: 'a'.repeat(64) } }));
    await host.connected(async () => ({ ring: { current: 'a'.repeat(64) } }));
    expect(started).toHaveLength(1);
    expect(started[0]!.stopped).toBe(false);
  });

  it('starts again with a new key, stopping the worker that had the old one', async () => {
    const started: ReturnType<typeof fakeWorker>[] = [];
    const lines: string[] = [];
    const host = new DeviceWorkerHost(async () => { const worker = fakeWorker(); started.push(worker); return worker; }, (line) => lines.push(line));
    await host.connected(async () => ({ ring: { current: 'a'.repeat(64) } }));
    await host.connected(async () => ({ ring: { current: 'b'.repeat(64), previous: ['a'.repeat(64)] } }));
    expect(started).toHaveLength(2);
    expect(started[0]!.stopped).toBe(true);
    expect(started[1]!.stopped).toBe(false);
    expect(lines).toContain('Koala\'s payload key or the way to its Temporal changed, so the engine worker starts again with it');
  });

  it('keeps the worker it has when the key cannot be fetched, and starts one again after it stopped', async () => {
    const started: ReturnType<typeof fakeWorker>[] = [];
    const lines: string[] = [];
    const host = new DeviceWorkerHost(async () => { const worker = fakeWorker(); started.push(worker); return worker; }, (line) => lines.push(line));
    await host.connected(async () => ({ ring: { current: 'a'.repeat(64) } }));
    await host.connected(async () => { throw new Error('this machine is not connected to Koala right now'); });
    expect(started).toHaveLength(1);
    expect(lines).toContain('the engine worker could not start: this machine is not connected to Koala right now');
    started[0]!.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.fingerprint).toBeUndefined();
    await host.connected(async () => ({ ring: { current: 'a'.repeat(64) } }));
    expect(started).toHaveLength(2);
  });

  it('starts again when Koala names another way to its Temporal, as when machines move to the gateway', async () => {
    const started: { address?: string | undefined }[] = [];
    const host = new DeviceWorkerHost(async (settings) => { started.push({ address: settings.temporal?.address }); return fakeWorker(); }, () => {});
    const ring = { current: 'a'.repeat(64) };
    await host.connected(async () => ({ ring, temporal: { address: '100.64.0.7:7233', namespace: 'default' } }));
    await host.connected(async () => ({ ring, temporal: { address: '100.64.0.7:7234', namespace: 'default' } }));
    await host.connected(async () => ({ ring, temporal: { address: '100.64.0.7:7234', namespace: 'default' } }));
    expect(started).toEqual([{ address: '100.64.0.7:7233' }, { address: '100.64.0.7:7234' }]);
  });
});
