import { describe, it, expect, vi } from 'vitest';
import { runGraph, type ExecutorPorts } from './executor.js';
import { createEventBus } from './events.js';
import { createRunState, type RunIdentity } from './run.js';
import { DELIVERY, seededAgentSlugs, definedToolNames } from './seeds.js';
import { graphErrors, validateGraph } from './graph.js';
import { createTaskTools, type TaskStore } from './adapters/task-tools.js';
import type { Task } from '../lib/tasks.js';

const identity = (): RunIdentity => ({
  runId: 'run-1',
  depth: 0,
  agentId: 'delivery',
  loopId: 'delivery',
  loopVersion: '1',
  trigger: 'user',
});

function taskWorld(initial: Task[] = []) {
  const stored = [...initial];
  const store: TaskStore = {
    list: async (ownerId) => stored.filter((task) => task.ownerId === ownerId),
    save: async (task) => {
      const index = stored.findIndex((candidate) => candidate.id === task.id);
      if (index >= 0) stored[index] = task;
      else stored.push(task);
    },
  };
  return { stored, tools: createTaskTools({ store, now: () => 'now' }) };
}

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  ownerId: 'user-1',
  title: over.id,
  doneMeans: 'it works',
  dependsOn: [],
  status: 'accepted',
  runs: [],
  createdAt: 'now',
  updatedAt: 'now',
  ...over,
});

const caller = { ownerId: 'user-1', projectId: 'p1', runId: 'run-1', agentSlug: 'delivery' };

function portsFor(world: ReturnType<typeof taskWorld>, over: Partial<ExecutorPorts> = {}): ExecutorPorts {
  return {
    callModel: vi.fn(async () => ({
      content: '', thinking: '', toolCalls: [], usage: undefined,
      finishReason: 'stop', unsupported: [], interrupted: undefined,
    })),

    runTool: vi.fn(async ({ node }) => {
      const toolNode = node as { tool: string; args?: Record<string, unknown> };
      const outcome = await world.tools[toolNode.tool]!({
        name: toolNode.tool,
        parsed: toolNode.args ?? {},
        driver: undefined,
        caller,
      });
      return { ok: outcome.ok, digest: outcome.digest, ...(outcome.content ? { content: outcome.content } : {}) };
    }),

    dispatchTool: vi.fn(async () => ({ ok: true, digest: '' })),

    runAgent: vi.fn(async ({ agent, inputs }) => {
      if (agent === 'planner') {
        return { runId: 'child-plan', agentId: agent, outcome: 'ok' as const, outputs: { proposed: 0 } };
      }

      const item = (inputs as { item?: { id?: string } }).item;
      if (item?.id) {
        await world.tools.mark_done!({
          name: 'mark_done',
          parsed: { taskId: item.id, evidence: 'done by a fake executor' },
          driver: undefined,
          caller,
        });
      }

      return { runId: `child-${item?.id ?? agent}`, agentId: agent, outcome: 'ok' as const, outputs: {} };
    }),

    mergeChildren: vi.fn(async () => ({})),
    awaitAnswer: vi.fn(async () => ({ answered: true, value: 'go' })),
    now: () => 0,
    ...over,
  };
}

const deliver = async (world: ReturnType<typeof taskWorld>, over: Partial<ExecutorPorts> = {}) => {
  const ports = portsFor(world, over);
  const result = await runGraph({
    graph: DELIVERY,
    identity: identity(),
    state: createRunState(0),
    budget: DELIVERY.budget ?? {},
    bus: createEventBus({ retain: 0 }),
    ports,
  });
  return { result, ports };
};

describe('the delivery loop', () => {
  it('is structurally sound — every node reachable, every cycle budgeted, agents resolvable', () => {
    const problems = validateGraph(DELIVERY, { agents: seededAgentSlugs() });
    expect(graphErrors(problems)).toEqual([]);
  });

  it('is still waiting on list_tasks, and says so rather than looking runnable', () => {
    const problems = graphErrors(
      validateGraph(DELIVERY, { agents: seededAgentSlugs(), tools: definedToolNames() }),
    ).map((problem) => problem.message);

    expect(problems.join(' ')).toContain('list_tasks');
  });

  it('plans, waits for review, then works through everything accepted', async () => {
    const world = taskWorld([task({ id: 'a' }), task({ id: 'b' })]);

    const { result, ports } = await deliver(world);

    expect(result.outcome).toBe('ok');
    expect(ports.awaitAnswer).toHaveBeenCalledTimes(1);
    expect(world.stored.every((entry) => entry.status === 'done')).toBe(true);
  });

  it('picks up work that only became ready because earlier work finished', async () => {
    const world = taskWorld([
      task({ id: 'first' }),
      task({ id: 'second', dependsOn: ['first'] }),
      task({ id: 'third', dependsOn: ['second'] }),
    ]);

    const { result } = await deliver(world);

    expect(result.outcome).toBe('ok');
    expect(world.stored.map((entry) => entry.status)).toEqual(['done', 'done', 'done']);
  });

  it('runs independent work in the same pass rather than one at a time', async () => {
    const world = taskWorld([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]);

    const { ports } = await deliver(world);

    const executorCalls = (ports.runAgent as unknown as { mock: { calls: [{ agent: string }][] } })
      .mock.calls.filter(([call]) => call.agent === 'executor');

    expect(executorCalls).toHaveLength(3);
  });

  it('settles immediately when nobody accepted anything', async () => {
    const world = taskWorld([task({ id: 'a', status: 'proposed' })]);

    const { result, ports } = await deliver(world);

    expect(result.outcome).toBe('ok');
    expect(ports.runAgent).toHaveBeenCalledTimes(1);
    expect(world.stored[0]?.status).toBe('proposed');
  });

  it('stops without doing the work if nobody ever reviews it', async () => {
    const world = taskWorld([task({ id: 'a' })]);

    const { result } = await deliver(world, {
      awaitAnswer: vi.fn(async () => ({ answered: false, reason: 'nobody answered in time' })),
    });

    expect(result).toMatchObject({ outcome: 'exhausted' });
    expect(world.stored[0]?.status).toBe('accepted');
  });

  it('leaves work that nothing can unblock rather than spinning on it', async () => {
    const world = taskWorld([
      task({ id: 'blocked', dependsOn: ['never'] }),
      task({ id: 'never', status: 'proposed' }),
    ]);

    const { result } = await deliver(world);

    expect(result.outcome).toBe('ok');
    expect(world.stored.find((entry) => entry.id === 'blocked')?.status).toBe('accepted');
  });
});
