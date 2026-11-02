import { describe, expect, it } from 'vitest';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { testDatabase } from '../../platform/lib/test-database.js';
import { TemporalBridge } from './TemporalBridge.js';

const bridgeWith = async (client?: Partial<Client['workflow']>): Promise<TemporalBridge> => {
  const bridge = new TemporalBridge(await testDatabase());
  if (client) Object.assign(bridge, { client: { workflow: client } as unknown as Client });
  return bridge;
};

const failing = (message: string) => async () => { throw new Error(message); };

describe('reading workflows for the Temporal page', () => {
  it('says Temporal is not reachable when the bridge has no client, rather than answering that nothing runs', async () => {
    const bridge = await bridgeWith();
    await expect(bridge.listWorkflows()).rejects.toMatchObject({ message: 'Temporal is not reachable', status: 503 });
    await expect(bridge.countWorkflows()).rejects.toMatchObject({ status: 503 });
    await expect(bridge.describeWorkflow('w1')).rejects.toMatchObject({ status: 503 });
    await expect(bridge.getWorkflowHistory('w1')).rejects.toMatchObject({ status: 503 });
  });

  it('raises a failure to count or describe with its reason instead of a zero or a missing workflow', async () => {
    const bridge = await bridgeWith({
      count: failing('the visibility store did not answer'),
      getHandle: (() => ({ describe: failing('deadline on the frontend'), fetchHistory: failing('deadline on the frontend') })) as never,
    });
    await expect(bridge.countWorkflows()).rejects.toThrow('the visibility store did not answer');
    await expect(bridge.describeWorkflow('w1')).rejects.toThrow('deadline on the frontend');
    await expect(bridge.getWorkflowHistory('w1')).rejects.toThrow('deadline on the frontend');
  });

  it('answers a workflow Temporal does not have as missing', async () => {
    const gone = async () => { throw new WorkflowNotFoundError('not found', 'w1', undefined); };
    const bridge = await bridgeWith({ getHandle: (() => ({ describe: gone, fetchHistory: gone })) as never });
    expect(await bridge.describeWorkflow('w1')).toBeNull();
    expect(await bridge.getWorkflowHistory('w1')).toBeNull();
  });
});
