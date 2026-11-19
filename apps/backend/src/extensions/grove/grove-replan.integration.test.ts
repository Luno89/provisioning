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

describe('the grove agent\'s procedure, when a leaf fails', () => {
  it('plans a failed leaf again with its failure in its worktree, and reports the plan waiting for a person', async () => {
    grove.judgeVerdicts = { leafB: 'failed' };

    const { result } = await grove.run({ agent: 'grove' });

    expect(grove.leafOf('leafB')).toMatchObject({ status: 'failed' });
    expect(grove.plans).toHaveLength(1);
    expect(grove.plans[0]).toMatchObject({ status: 'proposed', leafPlan: { leafId: 'leafB', mode: 'replan' } });
    expect(result).toEqual({ treeId: 'tree-1', outcome: 'quiet', awaitingReview: [], awaitingApproval: [grove.plans[0]!.id] });
    expect(grove.leafOf('leafC')?.status).toBe('pending');
  });

  it('settles a claim whose own checks fail without a judge, and plans it again', async () => {
    const { worktreeOfCall } = await grove.run({ agent: 'grove', failChecksOf: 'leafA' });

    expect(grove.leafOf('leafA')).toMatchObject({ status: 'failed', review: { model: 'grove-check-runner' } });
    expect(worktreeOfCall.filter((call) => call.startsWith('leaf-judge') && call.includes('leafA'))).toEqual([]);
    expect(grove.plans.map((plan) => plan.leafPlan?.leafId)).toContain('leafA');
  });

  it('puts a leaf that turns out to have no tasks back for the planner', async () => {
    await grove.run({ agent: 'grove', vanishTasksOf: 'leafA' });

    expect(grove.leafOf('leafA')).toMatchObject({ status: 'pending' });
    expect(grove.leafOf('leafA')?.claim).toBeUndefined();
    expect(grove.plans.map((plan) => plan.leafPlan?.leafId)).toEqual(['leafA']);
  });

  it('a failed task stops the leaf after one attempt and goes to the judge, whose diagnosis is what the replan starts from', async () => {
    grove.taskVerdict = 'no';
    grove.judgeVerdicts = { leafA: 'failed', leafB: 'failed' };

    const { worktreeOfCall } = await grove.run({});

    const leafA = grove.leafOf('leafA')!;
    expect(worktreeOfCall.filter((call) => call.includes('leafA')), 'the failed task was worked again instead of going to the judge').toEqual([
      'executor start_task trees/leafA',
      'executor task_status trees/leafA',
      'executor mark_failed trees/leafA',
      'leaf-judge settle_leaf judge/leafA',
      'planner propose_leaf_plan trees/leafA',
    ]);
    expect(leafA.claim?.evidence ?? '', 'the claim does not say which task failed').toMatch(/\[failed\]/);
    expect(leafA.status).toBe('failed');
    expect(leafA.findings ?? '').toMatch(/re-derived from the commit pointer seed-A/);
    expect(grove.plans.some((plan) => JSON.stringify(plan).includes('leafA')), 'nothing replanned the leaf the judge failed').toBe(true);
  });
});
