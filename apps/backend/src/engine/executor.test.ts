import { describe, it, expect, vi } from 'vitest';
import { runGraph, type ExecutorPorts } from './executor.js';
import { createEventBus, type EngineEvent } from './events.js';
import { createRunState, type RunIdentity } from './run.js';
import type { LoopGraph } from './graph.js';
import type { ModelCallResult } from './model-call.js';

const identity = (over: Partial<RunIdentity> = {}): RunIdentity => ({
  runId: 'run-1',
  depth: 0,
  agentId: 'tester',
  loopId: 'test-loop',
  loopVersion: '1',
  trigger: 'user',
  ...over,
});

const reply = (over: Partial<ModelCallResult> = {}): ModelCallResult => ({
  content: 'done thinking',
  thinking: '',
  toolCalls: [],
  usage: undefined,
  finishReason: 'stop',
  unsupported: [],
  interrupted: undefined,
  ...over,
});

function ports(over: Partial<ExecutorPorts> = {}): ExecutorPorts {
  return {
    callModel: vi.fn(async () => reply()),
    runTool: vi.fn(async () => ({ ok: true, digest: 'tool output' })),
    runAgent: vi.fn(async ({ agent }) => ({ runId: `child-${agent}`, agentId: agent, outcome: 'ok' as const, outputs: { from: agent } })),
    runTransform: vi.fn(async () => ({ shaped: true })),
    mergeChildren: vi.fn(async ({ children }) => ({ merged: children.length })),
    now: () => 1_000,
    ...over,
  };
}

async function execute(graph: LoopGraph, over: Partial<ExecutorPorts> = {}, opts: { budget?: Parameters<typeof runGraph>[0]['budget']; signal?: AbortSignal } = {}) {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const used = ports(over);
  const result = await runGraph({
    graph,
    identity: identity(),
    state: createRunState(0),
    budget: opts.budget ?? { maxRounds: 10 },
    bus,
    ports: used,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return { result, events, ports: used };
}

describe('runGraph', () => {
  it('walks a linear loop and settles at the terminal', async () => {
    const { result, events } = await execute({
      id: 'l', version: '1', entry: 'ask',
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    expect(result.outcome).toBe('ok');
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', outcome: 'ok' });
    expect(events.filter((e) => e.type === 'node.entered').map((e) => (e as { nodeId: string }).nodeId))
      .toEqual(['ask', 'done']);
  });

  it('routes on the first condition that passes', async () => {
    const graph: LoopGraph = {
      id: 'l', version: '1', entry: 'ask',
      nodes: [
        { kind: 'model', id: 'ask', next: [
          { to: 'empty', when: 'empty(reply.content)' },
          { to: 'spoke', when: 'len(reply.content) > 0' },
        ] },
        { kind: 'terminal', id: 'empty', outcome: 'failed', reason: 'said nothing' },
        { kind: 'terminal', id: 'spoke', outcome: 'ok' },
      ],
    };

    const spoke = await execute(graph);
    expect(spoke.result.outcome).toBe('ok');

    const silent = await execute(graph, { callModel: vi.fn(async () => reply({ content: '' })) });
    expect(silent.result).toMatchObject({ outcome: 'failed', reason: 'said nothing' });
  });

  it('loops until the round budget runs out and reports why', async () => {
    const { result, ports: used } = await execute({
      id: 'l', version: '1', entry: 'ask',
      budget: { maxRounds: 3 },
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'ask' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    }, {}, { budget: { maxRounds: 3 } });

    expect(result.outcome).toBe('exhausted');
    expect(result.reason).toMatch(/all 3 rounds/);
    expect(used.callModel).toHaveBeenCalledTimes(3);
  });

  it('stops when the model call reports an interrupt and keeps what it had', async () => {
    const { result, events } = await execute({
      id: 'l', version: '1', entry: 'ask',
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    }, { callModel: vi.fn(async () => reply({ content: 'partial', interrupted: 'overthinking' })) });

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'overthinking' });
    expect(events.some((e) => e.type === 'interrupted')).toBe(true);
  });

  it('stops before the next node when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const { result } = await execute({
      id: 'l', version: '1', entry: 'ask',
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    }, {}, { signal: controller.signal });

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'Stopped' });
  });

  it('runs a tool node, records it, and emits call and result events', async () => {
    const { result, events } = await execute({
      id: 'l', version: '1', entry: 'fetch',
      nodes: [
        { kind: 'tool', id: 'fetch', tool: 'read_file', args: { path: 'README.md' }, next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    expect(result.outcome).toBe('ok');
    expect(events.find((e) => e.type === 'tool.called')).toMatchObject({ name: 'read_file' });
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ ok: true, digest: 'tool output' });
  });

  it('calls another agent and stores its outputs under the declared name', async () => {
    const { result } = await execute({
      id: 'l', version: '1', entry: 'delegate',
      nodes: [
        { kind: 'agent', id: 'delegate', agent: 'research', as: 'research', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    expect(result.outputs).toEqual({ research: { from: 'research' } });
    expect(result.counters.childRuns).toBe(1);
  });

  it('applies a transform into outputs', async () => {
    const { result } = await execute({
      id: 'l', version: '1', entry: 'shape',
      nodes: [
        { kind: 'transform', id: 'shape', transform: 'extract', next: [{ to: 'done' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    expect(result.outputs).toEqual({ shaped: true });
  });

  it('fans out per item, joins, and merges the children', async () => {
    const bus = createEventBus();
    const used = ports();
    const state = createRunState(0);
    state.outputs.items = ['a', 'b', 'c'];

    const result = await runGraph({
      graph: {
        id: 'l', version: '1', entry: 'spread',
        nodes: [
          { kind: 'fanout', id: 'spread', over: 'outputs.items', agent: 'worker', as: 'each', join: 'join' },
          { kind: 'merge', id: 'join', next: [{ to: 'done' }] },
          { kind: 'terminal', id: 'done', outcome: 'ok' },
        ],
      },
      identity: identity(),
      state,
      budget: { maxRounds: 10 },
      bus,
      ports: used,
    });

    expect(used.runAgent).toHaveBeenCalledTimes(3);
    expect(result.counters.childRuns).toBe(3);
    expect(result.outputs.merged).toBe(3);
    expect((result.outputs.each as unknown[]).length).toBe(3);
  });

  it('honours maxParallel when fanning out', async () => {
    let inFlight = 0;
    let peak = 0;
    const runAgent = vi.fn(async ({ agent }: { agent: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { runId: 'c', agentId: agent, outcome: 'ok' as const, outputs: {} };
    });

    const state = createRunState(0);
    state.outputs.items = [1, 2, 3, 4];

    await runGraph({
      graph: {
        id: 'l', version: '1', entry: 'spread',
        nodes: [
          { kind: 'fanout', id: 'spread', over: 'outputs.items', agent: 'worker', join: 'join', maxParallel: 2 },
          { kind: 'merge', id: 'join', next: [{ to: 'done' }] },
          { kind: 'terminal', id: 'done', outcome: 'ok' },
        ],
      },
      identity: identity(),
      state,
      budget: { maxRounds: 10 },
      bus: createEventBus(),
      ports: ports({ runAgent: runAgent as unknown as ExecutorPorts['runAgent'] }),
    });

    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
  });

  it('fails cleanly when no route out of a node matches', async () => {
    const { result } = await execute({
      id: 'l', version: '1', entry: 'ask',
      nodes: [
        { kind: 'model', id: 'ask', next: [{ to: 'done', when: 'counters.rounds > 99' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    });

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.reason).toMatch(/no route out of "ask"/);
  });

  it('fails cleanly when a node points at something missing at runtime', async () => {
    const { result } = await execute({
      id: 'l', version: '1', entry: 'ghost',
      nodes: [{ kind: 'terminal', id: 'done', outcome: 'ok' }],
    });

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.reason).toMatch(/"ghost", which does not exist/);
  });

  it('stops at the hard step cap even if a budget would allow more', async () => {
    const { result } = await execute({
      id: 'l', version: '1', entry: 'spin',
      nodes: [
        { kind: 'branch', id: 'spin', next: [{ to: 'spin' }] },
        { kind: 'terminal', id: 'done', outcome: 'ok' },
      ],
    }, {}, { budget: {} });

    expect(result.outcome).toBe('exhausted');
    expect(result.reason).toMatch(/without settling/);
  });
});
