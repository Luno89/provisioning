import { describe, it, expect, vi } from 'vitest';
import { runGraph, type ExecutorPorts } from '../executor.js';
import { createDefaultRegistry } from './builtins.js';
import { createRegistry, type NodeHandler } from './types.js';
import { createEventBus, type EngineEvent } from '../events.js';
import { createRunState, type RunIdentity } from '../run.js';
import { validateGraph, graphErrors, type LoopGraph } from '../graph.js';
import type { ModelCallResult } from '../model-call.js';

const identity = (): RunIdentity => ({
  runId: 'run-1',
  depth: 0,
  agentId: 'tester',
  loopId: 'l',
  loopVersion: '1',
  trigger: 'user',
});

const reply = (over: Partial<ModelCallResult> = {}): ModelCallResult => ({
  content: 'ok',
  thinking: '',
  toolCalls: [],
  usage: undefined,
  finishReason: 'stop',
  unsupported: [],
  interrupted: undefined,
  ...over,
});

const ports = (over: Partial<ExecutorPorts> = {}): ExecutorPorts => ({
  callModel: vi.fn(async () => reply()),
  runTool: vi.fn(async () => ({ ok: true, digest: 'tool ran' })),
  dispatchTool: vi.fn(async () => ({ ok: true, digest: '' })),
  runAgent: vi.fn(async ({ agent }) => ({ runId: `c-${agent}`, agentId: agent, outcome: 'ok' as const, outputs: { from: agent } })),
  mergeChildren: vi.fn(async () => ({})),
  now: () => 0,
  ...over,
});

async function execute(graph: LoopGraph, over: Partial<ExecutorPorts> = {}, registry = createDefaultRegistry()) {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const used = ports(over);

  const result = await runGraph({
    graph,
    identity: identity(),
    state: createRunState(0),
    budget: graph.budget ?? { maxRounds: 10 },
    bus,
    ports: used,
    registry,
  });

  return { result, events, ports: used };
}

describe('node registry', () => {
  it('ships a handler for every node kind the graph types allow', () => {
    expect(createDefaultRegistry().kinds()).toEqual([
      'agent', 'branch', 'dispatch', 'fanout', 'merge', 'model', 'parallel', 'terminal', 'tool', 'wait',
    ]);
  });

  it('fails the run readably when a graph uses a kind nothing handles', async () => {
    const empty = createRegistry();
    const { result } = await execute({
      id: 'l', version: '1', entry: 'ask',
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    }, {}, empty);

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.reason).toMatch(/nothing knows how to run a "model" node/);
  });

  it('lets a new kind be added without touching the executor', async () => {
    const registry = createDefaultRegistry();
    const stamp: NodeHandler = async (ctx) => {
      ctx.state.outputs.stamped = true;
      return {};
    };
    registry.register('stamp', stamp as NodeHandler<never>);

    const { result } = await execute({
      id: 'l', version: '1', entry: 'mark',
      nodes: [
        { kind: 'stamp', id: 'mark', next: [{ to: 'done' }] } as never,
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    }, {}, registry);

    expect(result.outcome).toBe('ok');
    expect(result.outputs.stamped).toBe(true);
  });
});

describe('wait node', () => {
  const graph: LoopGraph = {
    id: 'l', version: '1', entry: 'ask',
    nodes: [
      { kind: 'wait', id: 'ask', prompt: 'Which database should I point it at?', as: 'answer', next: [{ to: 'done' }] },
      { kind: 'terminal', id: 'done', outcome: 'ok' },
    ],
  };

  it('pauses for an answer and carries it forward', async () => {
    const awaitAnswer = vi.fn(async () => ({ answered: true, value: 'the staging one' }));
    const { result, events } = await execute(graph, { awaitAnswer });

    expect(awaitAnswer).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('ok');
    expect(result.outputs.answer).toBe('the staging one');
    expect(events.find((e) => e.type === 'notice')).toMatchObject({ message: 'Which database should I point it at?' });
  });

  it('settles as exhausted when nobody answers', async () => {
    const { result } = await execute(graph, {
      awaitAnswer: vi.fn(async () => ({ answered: false, reason: 'nobody replied within a day' })),
    });

    expect(result).toMatchObject({ outcome: 'exhausted', reason: 'nobody replied within a day' });
  });

  it('says plainly when the runtime cannot wait at all', async () => {
    const { result } = await execute(graph);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.reason).toMatch(/cannot pause to ask a person/);
  });
});

describe('parallel node', () => {
  const graph: LoopGraph = {
    id: 'l', version: '1', entry: 'both',
    nodes: [
      { kind: 'parallel', id: 'both', branches: ['tests', 'lint'], join: 'join' },
      { kind: 'agent', id: 'tests', agent: 'test-runner', as: 'tests', next: [{ to: 'join' }] },
      { kind: 'agent', id: 'lint', agent: 'linter', as: 'lint', next: [{ to: 'join' }] },
      { kind: 'merge', id: 'join', next: [{ to: 'done' }] },
      { kind: 'terminal', id: 'done', outcome: 'ok' },
    ],
  };

  it('runs different branches at the same time and joins', async () => {
    const started: string[] = [];
    const runAgent = vi.fn(async ({ agent }: { agent: string }) => {
      started.push(agent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { runId: `c-${agent}`, agentId: agent, outcome: 'ok' as const, outputs: { from: agent } };
    });

    const { result } = await execute(graph, { runAgent: runAgent as unknown as ExecutorPorts['runAgent'] });

    expect(started.sort()).toEqual(['linter', 'test-runner']);
    expect(result.outcome).toBe('ok');
    expect(result.counters.childRuns).toBe(2);
  });

  it('really does overlap rather than running one after the other', async () => {
    let inFlight = 0;
    let peak = 0;
    const runAgent = vi.fn(async ({ agent }: { agent: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { runId: 'c', agentId: agent, outcome: 'ok' as const, outputs: {} };
    });

    await execute(graph, { runAgent: runAgent as unknown as ExecutorPorts['runAgent'] });
    expect(peak).toBe(2);
  });

  it('settles with the failure when one branch fails', async () => {
    const failing: LoopGraph = {
      id: 'l', version: '1', entry: 'both',
      nodes: [
        { kind: 'parallel', id: 'both', branches: ['ok', 'bad'], join: 'join' },
        { kind: 'agent', id: 'ok', agent: 'fine', next: [{ to: 'join' }] },
        { kind: 'terminal', id: 'bad', outcome: 'failed', reason: 'the lint step blew up' },
        { kind: 'merge', id: 'join', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const { result } = await execute(failing);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'the lint step blew up' });
  });

  it('validates its branches and join target', () => {
    const broken: LoopGraph = {
      id: 'l', version: '1', entry: 'both',
      nodes: [
        { kind: 'parallel', id: 'both', branches: ['ghost'], join: 'nowhere' },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    const messages = validateGraph(broken).map((problem) => problem.message);
    expect(messages).toContain('runs "ghost" in parallel, which does not exist');
    expect(messages).toContain('joins at "nowhere", which does not exist');
  });

  it('rejects a parallel node that runs nothing', () => {
    const empty: LoopGraph = {
      id: 'l', version: '1', entry: 'both',
      nodes: [
        { kind: 'parallel', id: 'both', branches: [], join: 'done' },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    };

    expect(graphErrors(validateGraph(empty)).map((p) => p.message)).toContain('runs nothing in parallel');
  });
});
