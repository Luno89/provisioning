import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { inMemoryPayloadBlobs } from '../lib/payload-storage.js';
import { PayloadStorageService } from './PayloadStorageService.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe('sweeping stored Temporal payloads against a real Temporal', () => {
  it('keeps the payloads of a workflow Temporal still has and releases those of one it has dropped', async () => {
    const blobs = inMemoryPayloadBlobs();
    const handle = await env.client.workflow.start('NeverRegistered', { taskQueue: 'nobody-polls', workflowId: `alive-${Date.now()}` });
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await blobs.put([
      { id: 'kept', data: new Uint8Array([1]), workflowId: handle.workflowId, storedAt: old },
      { id: 'released', data: new Uint8Array([1]), workflowId: 'never-existed', storedAt: old },
    ]);
    const service = new PayloadStorageService(blobs, async () => env.client);

    const report = await service.sweep();

    expect(report.released).toEqual(['never-existed']);
    expect([...blobs.stored.keys()]).toEqual(['kept']);
    expect(await service.retentionMs()).toBeGreaterThan(0);
    await handle.terminate();
  }, 120_000);
});
