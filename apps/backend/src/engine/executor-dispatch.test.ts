import { describe, it, expect, vi } from 'vitest';
import { runGraph, type ExecutorPorts } from './executor.js';
import { createEventBus, type EngineEvent } from './events.js';
import { createRunState, type RunIdentity } from './run.js';
import { INTERACTIVE_CHAT } from './seeds.js';
import type { ModelCallResult } from './model-call.js';

const identity = (): RunIdentity => ({
  runId: 'run-1',
  depth: 0,
  agentId: 'koala',
  loopId: 'interactive-chat',
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

const ports = (over: Partial<ExecutorPorts> = {}): ExecutorPorts => ({
  callModel: vi.fn(async () => reply({ content: 'all done' })),
  runTool: vi.fn(async () => ({ ok: true, digest: '' })),
  dispatchTool: vi.fn(async () => ({ ok: true, digest: 'tool said yes' })),
  runAgent: vi.fn(async () => ({ runId: 'c', agentId: 'a', outcome: 'ok' as const, outputs: {} })),
  mergeChildren: vi.fn(async () => ({})),
  now: () => 0,
  ...over,
});

async function run(over: Partial<ExecutorPorts> = {}) {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const used = ports(over);
  const result = await runGraph({
    graph: INTERACTIVE_CHAT,
    identity: identity(),
    state: createRunState(0),
    budget: INTERACTIVE_CHAT.budget ?? {},
    bus,
    ports: used,
  });

  return { result, events, ports: used };
}

describe('dispatch node', () => {
  it('runs every tool call the model asked for, then goes back to the model', async () => {
    let round = 0;
    const callModel = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return reply({
          toolCalls: [
            { id: 't1', name: 'search_web', arguments: '{"q":"pods"}' },
            { id: 't2', name: 'read_file', arguments: '{"path":"README.md"}' },
          ],
        });
      }
      return reply({ content: 'here is what I found' });
    });

    const { result, events, ports: used } = await run({ callModel: callModel as unknown as ExecutorPorts['callModel'] });

    expect(result.outcome).toBe('ok');
    expect(used.dispatchTool).toHaveBeenCalledTimes(2);
    expect(result.counters.toolCalls).toBe(2);
    expect(result.counters.rounds).toBe(2);

    const called = events.filter((e) => e.type === 'tool.called').map((e) => (e as { name: string }).name);
    expect(called).toEqual(['search_web', 'read_file']);
  });

  it('passes each individual call through to the port', async () => {
    let round = 0;
    const callModel = vi.fn(async () => {
      round += 1;
      return round === 1
        ? reply({ toolCalls: [{ id: 't1', name: 'search_web', arguments: '{"q":"x"}' }] })
        : reply({ content: 'done' });
    });

    const dispatchTool = vi.fn(async () => ({ ok: true, digest: 'found it' }));
    await run({
      callModel: callModel as unknown as ExecutorPorts['callModel'],
      dispatchTool: dispatchTool as unknown as ExecutorPorts['dispatchTool'],
    });

    expect((dispatchTool.mock.calls as unknown as { call: unknown }[][])[0]?.[0]).toMatchObject({
      call: { id: 't1', name: 'search_web', arguments: '{"q":"x"}' },
    });
  });

  it('clears the pending calls so the next round does not run them again', async () => {
    let round = 0;
    const callModel = vi.fn(async () => {
      round += 1;
      if (round === 1) return reply({ toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }] });
      if (round === 2) return reply({ toolCalls: [{ id: 't2', name: 'read_file', arguments: '{}' }] });
      return reply({ content: 'finished' });
    });

    const { result, ports: used } = await run({ callModel: callModel as unknown as ExecutorPorts['callModel'] });

    expect(used.dispatchTool).toHaveBeenCalledTimes(2);
    expect(result.counters.toolCalls).toBe(2);
  });

  it('records a failing tool call without abandoning the run', async () => {
    let round = 0;
    const callModel = vi.fn(async () => {
      round += 1;
      return round === 1
        ? reply({ toolCalls: [{ id: 't1', name: 'run_command', arguments: '{}' }] })
        : reply({ content: 'recovered' });
    });

    const { result, events } = await run({
      callModel: callModel as unknown as ExecutorPorts['callModel'],
      dispatchTool: vi.fn(async () => ({ ok: false, digest: 'command not found' })),
    });

    expect(result.outcome).toBe('ok');
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ ok: false, digest: 'command not found' });
  });

  it('settles straight away when the model answers with no tool calls', async () => {
    const { result, ports: used } = await run();

    expect(result.outcome).toBe('ok');
    expect(used.dispatchTool).not.toHaveBeenCalled();
    expect(result.counters.rounds).toBe(1);
  });

  it('goes back for more when the model was cut off at the length limit', async () => {
    let round = 0;
    const callModel = vi.fn(async () => {
      round += 1;
      return round === 1
        ? reply({ content: 'half an answ', finishReason: 'length' })
        : reply({ content: 'the rest of it' });
    });

    const { result } = await run({ callModel: callModel as unknown as ExecutorPorts['callModel'] });

    expect(result.outcome).toBe('ok');
    expect(result.counters.rounds).toBe(2);
  });
});
