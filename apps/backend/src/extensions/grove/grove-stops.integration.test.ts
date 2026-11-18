import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { realTemporalEnvironment } from '../../workflows/temporal-test-env.js';
import { GroveWorld } from './testing/grove-world.js';
import { cancelSignal } from '../../workflows/AgentRunWorkflow.js';

let env: TestWorkflowEnvironment;
let grove: GroveWorld;

beforeAll(async () => {
  env = await realTemporalEnvironment();
  grove = new GroveWorld(env);
});

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => grove.reset());

describe('stopping the grove agent\'s work', () => {
  it('cancelling one leaf stops its run alone, and the rest of the tree is still worked', async () => {
    await grove.run({
      hang: 'exec-leafA',
      drive: async (_handle, firstCall) => {
        await firstCall('exec-leafA');
        const leafA = grove.leafOf('leafA')!;
        expect(leafA.runId, 'the leaf does not say which run is working it').toBeTruthy();
        grove.leaves = grove.leaves.map((leaf) => (leaf.id === 'leafA' ? { ...leaf, status: 'cancelled' } : leaf));
        await env.client.workflow.getHandle(leafA.runId!).signal(cancelSignal);
      },
    });

    expect(grove.leafOf('leafA')?.status).toBe('cancelled');
    expect(grove.leafOf('leafB')).toMatchObject({ status: 'succeeded', verified: true });
  });

  it('stopping the run stops the leaf mid-task, puts it back to waiting and parks the workspace', async () => {
    const { outcome, parkedTrees, traces } = await grove.run({
      agent: 'grove',
      hang: 'exec-leafA',
      drive: async (handle, firstCall) => {
        await firstCall('exec-leafA');
        await handle.signal(cancelSignal);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'interrupted' });
    expect(grove.leafOf('leafA')).toMatchObject({ status: 'pending' });
    expect(grove.leafOf('leafA')?.claim).toBeUndefined();
    expect(parkedTrees).toEqual(['tree-1']);
    expect(traces.filter((trace) => trace.error !== undefined).map(({ runId, node, error }) => ({ runId, node, error })), 'a step the stop caught in flight reads as failed').toEqual([]);
    expect(traces).toContainEqual(expect.objectContaining({ kind: 'call-model', interrupted: 'the run was cancelled' }));
  });
});
