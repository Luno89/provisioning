import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';
import type { PayloadBlobs } from '../lib/payload-storage.js';
import { PayloadStorageService } from './PayloadStorageService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function temporalWith(options: { retentionSeconds?: number; alive?: readonly string[]; failing?: string }) {
  const client = mockDeep<Client>();
  client.workflowService.describeNamespace.mockResolvedValue({
    config: options.retentionSeconds === undefined ? undefined : { workflowExecutionRetentionTtl: { seconds: options.retentionSeconds } },
  } as unknown as Awaited<ReturnType<Client['workflowService']['describeNamespace']>>);
  client.workflow.getHandle.mockImplementation(((workflowId: string) => ({
    describe: async () => {
      if (workflowId === options.failing) throw new Error('temporal is down');
      if (!options.alive?.includes(workflowId)) throw new WorkflowNotFoundError('not found', workflowId, undefined);
      return {};
    },
  })) as never);
  return client;
}

describe('sweeping stored Temporal payloads', () => {
  it('reads the retention from the namespace, and falls back to a day when it has none', async () => {
    expect(await new PayloadStorageService(mock<PayloadBlobs>(), async () => temporalWith({ retentionSeconds: 7200 })).retentionMs()).toBe(7_200_000);
    expect(await new PayloadStorageService(mock<PayloadBlobs>(), async () => temporalWith({})).retentionMs()).toBe(DAY_MS);
    expect(await new PayloadStorageService(mock<PayloadBlobs>(), async () => temporalWith({ retentionSeconds: 0 })).retentionMs()).toBe(DAY_MS);
  });

  it('asks for the namespace it was given', async () => {
    const client = temporalWith({ retentionSeconds: 60 });
    await new PayloadStorageService(mock<PayloadBlobs>(), async () => client, 'tenant-1').retentionMs();
    expect(client.workflowService.describeNamespace).toHaveBeenCalledWith({ namespace: 'tenant-1' });
  });

  it('keeps the payloads of a workflow Temporal still has and releases those of one it has dropped', async () => {
    const blobs = mock<PayloadBlobs>();
    blobs.workflowsStoredBefore.mockResolvedValue(['kept', 'never-existed']);
    blobs.release.mockResolvedValue(1);
    blobs.releaseOrphansBefore.mockResolvedValue(3);
    const now = new Date('2026-11-02T00:00:00Z');
    const service = new PayloadStorageService(blobs, async () => temporalWith({ retentionSeconds: 3600, alive: ['kept'] }));

    const report = await service.sweep(now);

    expect(report).toEqual({ released: ['never-existed'], kept: 1, orphans: 3 });
    expect(blobs.workflowsStoredBefore).toHaveBeenCalledWith(new Date(now.getTime() - 3_600_000));
    expect(blobs.release).toHaveBeenCalledTimes(1);
    expect(blobs.release).toHaveBeenCalledWith('never-existed');
  });

  it('releases nothing when Temporal cannot say whether a workflow exists', async () => {
    const blobs = mock<PayloadBlobs>();
    blobs.workflowsStoredBefore.mockResolvedValue(['unsure']);
    const service = new PayloadStorageService(blobs, async () => temporalWith({ retentionSeconds: 3600, failing: 'unsure' }));
    await expect(service.sweep()).rejects.toThrow('temporal is down');
    expect(blobs.release).not.toHaveBeenCalled();
  });
});
