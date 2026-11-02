import { describe, expect, it, vi } from 'vitest';
import WorkerService from './WorkerService.js';

describe('WorkerService', () => {
  it('has no worker until one is started', () => {
    expect(new WorkerService().status()).toBeNull();
  });

  it('starts a worker for a cluster in the context named, local by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const service = new WorkerService();
    expect(await service.start('c1')).toEqual({ clusterId: 'c1', context: 'local', state: 'running' });
    expect(await service.start('c2', 'k3d-c2')).toEqual({ clusterId: 'c2', context: 'k3d-c2', state: 'running' });
    expect(service.status()).toEqual({ clusterId: 'c2', context: 'k3d-c2', state: 'running' });
    log.mockRestore();
  });

  it('refuses to start without a cluster', async () => {
    await expect(new WorkerService().start('')).rejects.toThrow('clusterId required');
  });

  it('stops the worker it started, and refuses to stop one that never started', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const service = new WorkerService();
    await expect(service.close()).rejects.toThrow('No Worker running');
    await service.start('c1');
    await service.close();
    expect(service.status()).toEqual({ clusterId: 'c1', context: 'local', state: 'stopped' });
    log.mockRestore();
  });
});
