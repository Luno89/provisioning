import { describe, it, expect, vi } from 'vitest';
import type { WorkflowStageNode } from '../lib/leaf-workflow-types.js';
import { runStageNodes, type StageCtx, type StageDispatch } from './leaf-workflow-interpreter.js';

vi.mock('@temporalio/workflow', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

const stage = (id: string, extra: Partial<WorkflowStageNode> = {}): WorkflowStageNode => (
  { id, name: id, stage: 'land', ...extra } as WorkflowStageNode
);

const freshCtx = (): StageCtx => ({ leaf: {}, treeType: {}, stages: {} });

describe('runStageNodes — leaves', () => {
  it('calls the dispatched activity and records ranOk', async () => {
    const calls: string[] = [];
    const dispatch: StageDispatch = {
      release: async () => { calls.push('release'); },
      judge: async () => ({ verdict: 'good' }),
      land: async () => { calls.push('land'); return { landed: [], stuck: [] }; },
      resolve: async () => {},
      accept: async () => {},
      replan: async () => {},
    };
    const ctx = freshCtx();
    await runStageNodes([stage('a', { stage: 'land' })], 'leaf1', ctx, dispatch);
    expect(calls).toEqual(['land']);
    expect(ctx.stages.a).toEqual({ ranOk: true, output: { landed: [], stuck: [] } });
  });

  it('records ranOk:false when an optional stage throws, and does not propagate the error', async () => {
    const dispatch: StageDispatch = {
      release: async () => {}, judge: async () => { throw new Error('boom'); },
      land: async () => {}, resolve: async () => {}, accept: async () => {}, replan: async () => {},
    };
    const ctx = freshCtx();
    await runStageNodes([stage('j', { stage: 'judge', optional: true })], 'leaf1', ctx, dispatch);
    expect(ctx.stages.j).toEqual({ ranOk: false, output: undefined });
  });

  it('propagates the error when a non-optional stage throws after exhausting retries', async () => {
    const dispatch: StageDispatch = {
      release: async () => {}, judge: async () => {},
      land: async () => { throw new Error('land failed'); },
      resolve: async () => {}, accept: async () => {}, replan: async () => {},
    };
    const ctx = freshCtx();
    await expect(runStageNodes([stage('l', { stage: 'land' })], 'leaf1', ctx, dispatch)).rejects.toThrow('land failed');
  });

  it('retries a failing stage the configured number of times before giving up', async () => {
    let calls = 0;
    const dispatch: StageDispatch = {
      release: async () => {}, judge: async () => {},
      land: async () => { calls++; if (calls < 3) throw new Error('flaky'); return 'ok'; },
      resolve: async () => {}, accept: async () => {}, replan: async () => {},
    };
    const ctx = freshCtx();
    await runStageNodes([stage('l', { stage: 'land', retries: 2, retryDelayMs: 1 })], 'leaf1', ctx, dispatch);
    expect(calls).toBe(3);
    expect(ctx.stages.l).toEqual({ ranOk: true, output: 'ok' });
  });

  it('skips a stage whose runIf did not pass, without calling its activity', async () => {
    const calls: string[] = [];
    const dispatch: StageDispatch = {
      release: async () => {}, judge: async () => {}, land: async () => { calls.push('land'); },
      resolve: async () => { calls.push('resolve'); }, accept: async () => {}, replan: async () => {},
    };
    const ctx = freshCtx();
    await runStageNodes(
      [stage('l', { stage: 'land' }), stage('r', { stage: 'resolve', runIf: { op: 'gt', path: 'stages.l.output.stuck', value: 0 } })],
      'leaf1', ctx, dispatch,
    );
    expect(calls).toEqual(['land']);
    expect(ctx.stages.r).toEqual({ ranOk: false, output: undefined });
  });

  it('runs a stage whose runIf condition on a prior stage\'s output passes', async () => {
    const calls: string[] = [];
    const dispatch: StageDispatch = {
      release: async () => {}, judge: async () => {},
      land: async () => ({ stuck: ['x'] }),
      resolve: async () => { calls.push('resolve'); }, accept: async () => {}, replan: async () => {},
    };
    const ctx = freshCtx();
    await runStageNodes(
      [stage('l', { stage: 'land' }), stage('r', { stage: 'resolve', runIf: { op: 'gt', path: 'stages.l.output.stuck.length', value: 0 } })],
      'leaf1', ctx, dispatch,
    );
    expect(calls).toEqual(['resolve']);
  });
});

describe('runStageNodes — groups and loops', () => {
  const baseDispatch = (): StageDispatch => ({
    release: async () => {}, judge: async () => {}, land: async () => {},
    resolve: async () => {}, accept: async () => {}, replan: async () => {},
  });

  it('a group\'s runIf skips every child when the target did not pass', async () => {
    const calls: string[] = [];
    const dispatch = baseDispatch();
    dispatch.judge = async () => { throw new Error('nope'); };
    dispatch.land = async () => { calls.push('land'); };
    const ctx = freshCtx();
    const tree: WorkflowStageNode[] = [
      stage('j', { stage: 'judge', optional: true }),
      { id: 'g', name: 'g', containerType: 'group', runIf: 'j', children: [stage('l', { stage: 'land' })] },
    ];
    await runStageNodes(tree, 'leaf1', ctx, dispatch);
    expect(calls).toEqual([]);
    expect(ctx.stages.g).toEqual({ ranOk: false, output: undefined });
  });

  it('a count loop runs its children exactly maxIterations times', async () => {
    let calls = 0;
    const dispatch = baseDispatch();
    dispatch.land = async () => { calls++; };
    const ctx = freshCtx();
    const tree: WorkflowStageNode[] = [
      { id: 'lp', name: 'lp', containerType: 'loop', loopType: 'count', maxIterations: 3, children: [stage('l', { stage: 'land' })] },
    ];
    await runStageNodes(tree, 'leaf1', ctx, dispatch);
    expect(calls).toBe(3);
  });

  it('an until loop stops as soon as one full iteration passes', async () => {
    let calls = 0;
    const dispatch = baseDispatch();
    dispatch.land = async () => { calls++; if (calls < 2) throw new Error('not yet'); };
    const ctx = freshCtx();
    const tree: WorkflowStageNode[] = [
      { id: 'lp', name: 'lp', containerType: 'loop', loopType: 'until', maxIterations: 5, children: [stage('l', { stage: 'land', optional: true })] },
    ];
    await runStageNodes(tree, 'leaf1', ctx, dispatch);
    expect(calls).toBe(2);
    expect(ctx.stages.lp).toEqual({ ranOk: true, output: undefined });
  });
});
