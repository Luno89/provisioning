import { describe, it, expect, vi } from 'vitest';
import { runGraph, type ExecutorPorts } from './executor.js';
import { createEventBus, type EngineEvent } from './events.js';
import { createMonitorSet, stallMonitor, toolFailureMonitor, type Monitor } from './monitors.js';
import { createRunState, type RunIdentity } from './run.js';
import type { LoopGraph } from './graph.js';
import type { ModelCallResult } from './model-call.js';

const identity = (): RunIdentity => ({
  runId: 'run-1',
  depth: 0,
  agentId: 'tester',
  loopId: 'test-loop',
  loopVersion: '1',
  trigger: 'user',
});

const reply = (over: Partial<ModelCallResult> = {}): ModelCallResult => ({
  content: '',
  thinking: '',
  toolCalls: [],
  usage: undefined,
  finishReason: 'stop',
  unsupported: [],
  interrupted: undefined,
  ...over,
});

const basePorts = (over: Partial<ExecutorPorts> = {}): ExecutorPorts => ({
  callModel: vi.fn(async () => reply()),
  runTool: vi.fn(async () => ({ ok: false, digest: 'boom' })),
  runAgent: vi.fn(async () => ({ runId: 'c', agentId: 'a', outcome: 'ok' as const, outputs: {} })),
  runTransform: vi.fn(async () => ({})),
  mergeChildren: vi.fn(async () => ({})),
  now: () => 0,
  ...over,
});

const loop: LoopGraph = {
  id: 'l', version: '1', entry: 'ask',
  nodes: [
    { kind: 'model', id: 'ask', next: [{ to: 'ask' }] },
    { kind: 'terminal', id: 'done', outcome: 'ok' },
  ],
};

describe('executor with monitors', () => {
  it('settles as interrupted when a round-level monitor fires', async () => {
    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));

    const result = await runGraph({
      graph: loop,
      identity: identity(),
      state: createRunState(0),
      budget: { maxRounds: 10 },
      bus,
      ports: basePorts(),
      monitors: createMonitorSet([stallMonitor({ maxSilentRounds: 2 })]),
    });

    expect(result.outcome).toBe('interrupted');
    expect(result.reason).toMatch(/nothing for 2 rounds in a row \(stalled\)/);
    expect(events.some((e) => e.type === 'interrupted')).toBe(true);
    expect(result.counters.rounds).toBe(2);
  });

  it('settles as interrupted when tools keep failing', async () => {
    const result = await runGraph({
      graph: {
        id: 'l', version: '1', entry: 'run',
        nodes: [
          { kind: 'tool', id: 'run', tool: 'shell', next: [{ to: 'run' }] },
          { kind: 'terminal', id: 'done', outcome: 'ok' },
        ],
      },
      identity: identity(),
      state: createRunState(0),
      budget: { maxToolCalls: 20 },
      bus: createEventBus(),
      ports: basePorts(),
      monitors: createMonitorSet([toolFailureMonitor({ maxConsecutiveFailures: 2 })]),
    });

    expect(result.outcome).toBe('interrupted');
    expect(result.reason).toMatch(/2 tool calls failed in a row \(tool-failures\)/);
  });

  it('hands the monitor sink to the model call so streaming can be interrupted', async () => {
    const callModel = vi.fn(async ({ sink }) => {
      const interrupt = sink?.({ kind: 'thinking', text: 'round and round' });
      return reply({ content: 'partial', ...(interrupt ? { interrupted: interrupt } : {}) });
    });

    const spinning: Monitor = { name: 'spinning', onThinking: () => 'caught it mid-stream' };

    const result = await runGraph({
      graph: loop,
      identity: identity(),
      state: createRunState(0),
      budget: { maxRounds: 5 },
      bus: createEventBus(),
      ports: basePorts({ callModel: callModel as unknown as ExecutorPorts['callModel'] }),
      monitors: createMonitorSet([spinning]),
    });

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'caught it mid-stream (spinning)' });
    expect(result.counters.rounds).toBe(1);
  });

  it('publishes detector values into run state so conditions can branch on them', async () => {
    const state = createRunState(0);

    await runGraph({
      graph: {
        id: 'l', version: '1', entry: 'ask',
        nodes: [
          { kind: 'model', id: 'ask', next: [
            { to: 'gaveUp', when: 'detectors.silentRounds > 0' },
            { to: 'done' },
          ] },
          { kind: 'terminal', id: 'gaveUp', outcome: 'failed', reason: 'went quiet' },
          { kind: 'terminal', id: 'done', outcome: 'ok' },
        ],
      },
      identity: identity(),
      state,
      budget: { maxRounds: 5 },
      bus: createEventBus(),
      ports: basePorts(),
      monitors: createMonitorSet([stallMonitor({ maxSilentRounds: 5 })]),
    });

    expect(state.detectors).toMatchObject({ silentRounds: 1 });
  });

  it('runs unchanged when no monitors are supplied', async () => {
    const result = await runGraph({
      graph: {
        id: 'l', version: '1', entry: 'ask',
        nodes: [
          { kind: 'model', id: 'ask', next: [{ to: 'done' }] },
          { kind: 'terminal', id: 'done', outcome: 'ok' },
        ],
      },
      identity: identity(),
      state: createRunState(0),
      budget: { maxRounds: 5 },
      bus: createEventBus(),
      ports: basePorts(),
    });

    expect(result.outcome).toBe('ok');
  });
});
