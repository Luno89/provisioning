import { describe, it, expect, vi } from 'vitest';
import { runProcedure } from '../interpreter.js';
import { createNodeCatalogue } from '../definition.js';
import { createNodeExecutor, valueImplementation } from '../implementation.js';
import { BUILT_IN_DEFINITIONS, WORKFLOW_IMPLEMENTATIONS, createOrchestrationNodes, type OrchestrationPorts } from '../nodes/index.js';
import type { ChildOutcomeValue } from '../values.js';
import { DELIVERY_V2 } from './procedures.js';

const used = new Set(DELIVERY_V2.nodes.map((node) => node.kind));
const catalogue = createNodeCatalogue(BUILT_IN_DEFINITIONS.filter((definition) => used.has(definition.kind)));

function deliver(executorOutcomes: Record<string, Omit<ChildOutcomeValue, 'runId' | 'agentId'>>) {
  let listed = 0;
  const ports: OrchestrationPorts = {
    runTool: vi.fn(async () => {
      listed += 1;
      const ready = listed === 1 ? Object.keys(executorOutcomes).map((id) => ({ id, title: `Task ${id}` })) : [];
      return { ok: true, digest: JSON.stringify(ready), content: JSON.stringify(ready) };
    }),
    runChild: vi.fn(async ({ agent, inputs }) => {
      if (agent === 'planner') return { runId: 'plan', agentId: agent, outcome: 'ok', outputs: { result: 'Two tasks: a writes the file, b checks it.' } };
      const id = (inputs.item as { id: string }).id;
      return { runId: `do-${id}`, agentId: agent, ...executorOutcomes[id]! } as ChildOutcomeValue;
    }),
    approve: vi.fn(async () => true),
    ask: vi.fn(async () => ({ answered: true, value: 'go' })),
  };
  const persona = valueImplementation('persona', () => ({ outputs: { persona: { slug: 'delivery', tools: ['list_tasks'] }, prompt: '', delegates: [] } }));
  const events: unknown[] = [];

  const result = runProcedure({
    procedure: DELIVERY_V2,
    catalogue,
    executor: createNodeExecutor(catalogue, [
      ...WORKFLOW_IMPLEMENTATIONS.filter((implementation) => used.has(implementation.kind)),
      ...createOrchestrationNodes(ports).filter((implementation) => used.has(implementation.kind)),
      persona,
    ]),
    identity: { runId: 'delivery-1', depth: 0, agentId: 'delivery', loopId: 'delivery', loopVersion: '2', trigger: 'user' },
    launch: { ownerId: 'user-1' },
    inputs: { goal: 'write hello.txt', message: 'write hello.txt' },
    bus: { emit: (event: unknown) => events.push(event) } as never,
  });
  return { result, ports, events };
}

describe('delivering a goal', () => {
  it('shows the person the plan it is asking them to accept', async () => {
    const { result, events } = deliver({ a: { outcome: 'ok', outputs: {} } });
    await result;

    expect(events).toContainEqual(expect.objectContaining({
      type: 'notice',
      nodeId: 'review',
      message: 'Here is the proposed work. Accept what you want on the task board, then reply to carry on.\n\nTwo tasks: a writes the file, b checks it.',
    }));
  });

  it('finishes ok, handing back every outcome, when all the work succeeded', async () => {
    const { result } = deliver({ a: { outcome: 'ok', outputs: {} }, b: { outcome: 'ok', outputs: {} } });

    expect(await result).toMatchObject({ outcome: 'ok', finishedBy: 'settled' });
    expect((await result).outputs.settled?.result).toEqual([
      expect.objectContaining({ runId: 'do-a', outcome: 'ok' }),
      expect.objectContaining({ runId: 'do-b', outcome: 'ok' }),
    ]);
  });

  it('fails, listing which work failed and why, when any task did not succeed', async () => {
    const { result } = deliver({
      a: { outcome: 'ok', outputs: {} },
      b: { outcome: 'failed', reason: 'the judge did not accept the work', outputs: {} },
    });

    expect(await result).toMatchObject({ outcome: 'failed', reason: 'some of the work failed — the result lists which tasks and why', finishedBy: 'someFailed' });
    expect((await result).outputs.someFailed?.result).toEqual([
      expect.objectContaining({ runId: 'do-b', reason: 'the judge did not accept the work' }),
    ]);
  });
});
