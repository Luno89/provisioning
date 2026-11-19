import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporalTestEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { GroveWorld } from './testing/grove-world.js';

let env: TestWorkflowEnvironment;
let grove: GroveWorld;

beforeAll(async () => {
  env = await temporalTestEnvironment();
  grove = new GroveWorld(env);
});

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => grove.reset());

describe('the grove agent\'s procedure', () => {
  it('works the independent leaves, judges their claims, then works and judges the leaf that waited on them', async () => {
    const { result, outcome, worktreeOfCall } = await grove.run({ agent: 'grove' });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ outcome: 'ok' });
    expect(result).toEqual({ treeId: 'tree-1', outcome: 'quiet', awaitingReview: [], awaitingApproval: [] });
    for (const id of ['leafA', 'leafB', 'leafC']) {
      expect(grove.leafOf(id), id).toMatchObject({ status: 'succeeded', verified: true });
    }
    expect(worktreeOfCall.some((call) => call.startsWith('executor ') && call.endsWith('trees/leafA'))).toBe(true);
    expect(worktreeOfCall.some((call) => call.startsWith('leaf-judge settle_leaf'))).toBe(true);
  });

  it('lands what it verified, and a verified story an earlier run left unlanded once nothing else is left to do', async () => {
    const merged: string[] = [];
    const first = await grove.run({ agent: 'grove', merges: async (head) => { merged.push(head); return 'merged'; } });
    expect(first.outcome, JSON.stringify(first.outcome)).toMatchObject({ outcome: 'ok' });
    expect(merged.sort()).toEqual(['leaf/leafA', 'leaf/leafB', 'leaf/leafC']);
    expect(grove.leaves.map((leaf) => [leaf.id, leaf.landed?.outcome])).toEqual([['leafA', 'merged'], ['leafB', 'merged'], ['leafC', 'merged']]);

    grove.leaves = grove.leaves.map((leaf) => { if (leaf.id !== 'leafC') return leaf; const { landed: _landed, ...rest } = leaf; return rest; });
    merged.length = 0;
    const second = await grove.run({ agent: 'grove', merges: async (head) => { merged.push(head); return 'merged'; } });
    expect(second.outcome).toMatchObject({ outcome: 'ok' });
    expect(merged).toEqual(['leaf/leafC']);
    expect(grove.leafOf('leafC')?.landed?.outcome).toBe('merged');
  });

  it('tells the run\'s turn log when a story did not land, rather than keeping it to the worker', async () => {
    const { published } = await grove.run({ agent: 'grove', merges: async () => 'failed' });
    const notices = published.filter((event) => event.type === 'notice').map((event) => (event as { message: string; nodeId?: string }));
    expect(notices.some((notice) => notice.nodeId === 'land' && /did not land this pass/.test(notice.message))).toBe(true);
    expect(grove.leaves.every((leaf) => !leaf.landed)).toBe(true);
  });
});
