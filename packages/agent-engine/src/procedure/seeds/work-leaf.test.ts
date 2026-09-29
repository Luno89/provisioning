import { describe, it, expect, vi } from 'vitest';
import { runProcedure } from '../interpreter.js';
import { createNodeCatalogue } from '../definition.js';
import { createNodeExecutor, valueImplementation } from '../implementation.js';
import { BUILT_IN_DEFINITIONS, WORKFLOW_IMPLEMENTATIONS, createOrchestrationNodes, type OrchestrationPorts } from '../nodes/index.js';
import type { ChildOutcomeValue } from '../values.js';
import { GROVE_WORK_LEAF } from './procedures.js';

const used = new Set(GROVE_WORK_LEAF.nodes.map((node) => node.kind));
const catalogue = createNodeCatalogue(BUILT_IN_DEFINITIONS.filter((definition) => used.has(definition.kind)));

const worktree = { kind: 'sandbox', id: 'engine-tree-t1', workspace: { runId: 'tree-t1' }, capabilities: { kind: 'sandbox', lifecycle: 'invocation' }, worktree: '/work/leaves/l1' } as never;

/** A ready task, as next_leaf_task hands one over. */
const ready = (id: string) => ({ says: { step: 'run', item: { id, title: `Task ${id}`, doneMeans: `${id} is true`, leafId: 'l1' } } });
/** The tool refusing, which is not the same as an answer. */
const refuses = (why: string) => ({ refuses: why });

type Ask = { says: unknown } | { refuses: string };

/** Runs the work procedure against a script of answers from next_leaf_task, and of executor endings.
 * Once a script runs out the tool refuses, so a loop that should have ended fails the test instead of
 * hanging the suite — the procedure itself has no ceiling, by design. */
function workLeaf(asks: readonly Ask[], executors: readonly Omit<ChildOutcomeValue, 'runId' | 'agentId'>[] = [{ outcome: 'ok', outputs: {} }], inputs: Record<string, unknown> = {}) {
  const asked: unknown[] = [];
  const handed: { inputs: Record<string, unknown>; environment?: unknown }[] = [];
  let askCount = 0;
  let workCount = 0;

  const ports: OrchestrationPorts = {
    runTool: vi.fn(async ({ call }) => {
      asked.push(JSON.parse(call.arguments || '{}'));
      const scripted = asks[askCount];
      askCount += 1;
      const answer = scripted === undefined ? { refuses: 'the leaf was asked for work after it had ended' } : scripted;
      if ('refuses' in answer) return { ok: false, digest: answer.refuses, content: answer.refuses };
      const text = JSON.stringify(answer.says);
      return { ok: true, digest: text, content: text };
    }),
    runChild: vi.fn(async (request) => {
      handed.push({ inputs: request.inputs, ...(request.environment ? { environment: request.environment } : {}) });
      const ending = executors[Math.min(workCount, executors.length - 1)]!;
      workCount += 1;
      return { runId: `do-${workCount}`, agentId: 'executor', ...ending } as ChildOutcomeValue;
    }),
    approve: vi.fn(async () => true),
    ask: vi.fn(async () => ({ answered: true, value: 'go' })),
  };
  const persona = valueImplementation('persona', () => ({ outputs: { persona: { slug: 'leaf-worker', tools: ['next_leaf_task'], agents: ['executor'] }, prompt: '', delegates: [] } }));

  const result = runProcedure({
    procedure: GROVE_WORK_LEAF,
    catalogue,
    executor: createNodeExecutor(catalogue, [
      ...WORKFLOW_IMPLEMENTATIONS.filter((implementation) => used.has(implementation.kind)),
      ...createOrchestrationNodes(ports).filter((implementation) => used.has(implementation.kind)),
      persona,
    ]),
    identity: { runId: 'tree-t1-l1-work', depth: 1, agentId: 'leaf-worker', loopId: 'leaf-worker', loopVersion: '1', trigger: 'agent' },
    launch: { ownerId: 'user-1', environment: worktree },
    inputs: { leafId: 'l1', leafTitle: 'Make a work', leafBody: 'a is true', siblings: '', message: 'work the leaf', ...inputs },
    bus: { emit: () => undefined } as never,
  });

  return { result, asked, handed, works: () => workCount };
}

describe('working a grove leaf', () => {
  it('hands each task to an executor in turn, then says the leaf can be claimed', async () => {
    const { result, asked, handed } = workLeaf([ready('a'), ready('b'), { says: { step: 'claim' } }]);
    const outcome = await result;

    expect(outcome).toMatchObject({ outcome: 'ok', finishedBy: 'claimed' });
    expect(outcome.outputs.claimed?.result).toEqual({ step: 'claim' });
    expect(asked).toEqual([{ leafId: 'l1', siblings: '' }, { leafId: 'l1', siblings: '' }, { leafId: 'l1', siblings: '' }]);
    expect(handed.map((call) => call.inputs.item)).toEqual([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })]);
    expect(handed.map((call) => call.inputs.message)).toEqual(['Work the task Task a.', 'Work the task Task b.']);
  });

  it('hands the leaf\'s own worktree to the executor, so the work lands where the leaf is', async () => {
    const { result, handed } = workLeaf([ready('a'), { says: { step: 'claim' } }]);
    await result;

    expect(handed.map((call) => call.environment)).toEqual([worktree]);
  });

  it('tells the executor how many other leaves are in flight, since it may not assume an unshared environment', async () => {
    const { result, asked } = workLeaf([{ says: { step: 'unbroken' } }], [{ outcome: 'ok', outputs: {} }], { siblings: '3 other leaves are being worked in this pass' });
    await result;

    expect(asked).toEqual([{ leafId: 'l1', siblings: '3 other leaves are being worked in this pass' }]);
  });

  it('hands back the failure and its reason when a task failed twice', async () => {
    const { result } = workLeaf([ready('a'), { says: { step: 'fail', reason: 'task a failed twice: the build still fails' } }]);
    const outcome = await result;

    expect(outcome).toMatchObject({ outcome: 'failed', finishedBy: 'failed' });
    expect(outcome.outputs.failed?.result).toEqual({ step: 'fail', reason: 'task a failed twice: the build still fails' });
  });

  it('hands back that there was nothing to work when the leaf has no tasks yet', async () => {
    const { result, works } = workLeaf([{ says: { step: 'unbroken' } }]);
    const outcome = await result;

    expect(outcome).toMatchObject({ outcome: 'refused', finishedBy: 'unbroken' });
    expect(outcome.outputs.unbroken?.result).toEqual({ step: 'unbroken' });
    expect(works()).toBe(0);
  });

  it('ends failed with what the tool said, and hands back no ending, when it cannot ask', async () => {
    const { result, works } = workLeaf([refuses('there is no leaf l1')]);
    const outcome = await result;

    expect(outcome).toMatchObject({ outcome: 'failed', finishedBy: 'couldNotAsk', reason: 'there is no leaf l1' });
    expect(outcome.outputs.couldNotAsk?.result).toBeUndefined();
    expect(works()).toBe(0);
  });

  it('asks again when an executor did not finish, leaving that verdict to the task records', async () => {
    const { result, works } = workLeaf(
      [ready('a'), ready('a'), { says: { step: 'claim' } }],
      [{ outcome: 'failed', reason: 'the executor ran out of budget', outputs: {} }, { outcome: 'ok', outputs: { summary: 'a is true now' } }],
    );
    const outcome = await result;

    expect(outcome).toMatchObject({ outcome: 'ok', finishedBy: 'claimed' });
    expect(works()).toBe(2);
  });
});
