import { describe, it, expect } from 'vitest';
import { runProcedure, type NodeTrace, type RunProcedureOptions } from './interpreter.js';
import type { Procedure } from './schema.js';
import { createEventBus, type EngineEvent } from '../runtime/events.js';
import {
  flow,
  group,
  groupNode,
  node,
  procedure,
  scriptedExecutor,
  testCatalogue,
  wire,
  type ScriptedExecutor,
} from '../../testing/procedure-nodes.js';

const identity = { runId: 'run-1', depth: 0, agentId: 'tester', loopId: 'test', loopVersion: '1', trigger: 'user' as const };

const run = (subject: Procedure, executor: ScriptedExecutor, over: Partial<RunProcedureOptions> = {}) => {
  let clock = 1_000;
  return runProcedure({
    procedure: subject,
    catalogue: testCatalogue(),
    executor,
    identity,
    launch: { ownerId: 'owner-1' },
    now: () => (clock += 10),
    ...over,
  });
};

const askThenFinish = procedure({
  start: 'ask',
  nodes: [
    node('greeting', 'note', { text: 'hello' }),
    node('ask', 'ask'),
    node('agreed', 'finish', { outcome: 'ok', reason: 'it agreed' }),
    node('refused', 'finish', { outcome: 'failed', reason: 'it refused' }),
  ],
  wires: [wire('greeting:text', 'ask:prompt')],
  flow: [flow('ask:yes', 'agreed'), flow('ask:no', 'refused')],
});

describe('running a procedure', () => {
  it('follows the exit a step leaves through and finishes with the outcome the finish node gives', async () => {
    const yes = await run(askThenFinish, scriptedExecutor({ ask: () => ({ exit: 'yes' }) }));
    const no = await run(askThenFinish, scriptedExecutor({ ask: () => ({ exit: 'no' }) }));

    expect(yes).toMatchObject({ outcome: 'ok', reason: 'it agreed', steps: 2, finishedBy: 'agreed' });
    expect(no).toMatchObject({ outcome: 'failed', reason: 'it refused', steps: 2 });
  });

  it('hands a step the value wired into it', async () => {
    const executor = scriptedExecutor({ ask: () => ({ exit: 'yes' }) });
    await run(askThenFinish, executor);

    expect(executor.calls.find((call) => call.node === 'ask')?.inputs).toEqual({ prompt: 'hello' });
  });

  it('collects every wire into a socket that takes many, in wire order', async () => {
    const executor = scriptedExecutor({ ask: () => ({ exit: 'yes' }) });
    const subject = {
      ...askThenFinish,
      nodes: [...askThenFinish.nodes, node('second', 'note', { text: 'world' }), node('joined', 'join-text', { separator: ' ' })],
      wires: [wire('second:text', 'joined:parts'), wire('greeting:text', 'joined:parts'), wire('joined:text', 'ask:prompt')],
    };

    await run(subject, executor);

    expect(executor.calls.find((call) => call.node === 'ask')?.inputs).toEqual({ prompt: 'world hello' });
  });

  it('works a value out once per step, even when two nodes read it', async () => {
    const executor = scriptedExecutor({ ask: () => ({ exit: 'yes' }) });
    const subject = {
      ...askThenFinish,
      nodes: [...askThenFinish.nodes, node('joined', 'join-text', { separator: '+' })],
      wires: [wire('greeting:text', 'joined:parts'), wire('greeting:text', 'joined:parts'), wire('joined:text', 'ask:prompt')],
    };

    await run(subject, executor);

    expect(executor.calls.filter((call) => call.node === 'greeting')).toHaveLength(1);
    expect(executor.calls.find((call) => call.node === 'ask')?.inputs).toEqual({ prompt: 'hello+hello' });
  });

  it('works a value out again for every step that needs it, so it is never stale', async () => {
    let asked = 0;
    const executor = scriptedExecutor(
      { ask: () => ({ exit: ++asked < 3 ? 'no' : 'yes' }) },
      { note: () => ({ outputs: { text: `attempt ${asked + 1}` } }) },
    );
    const subject = { ...askThenFinish, budget: { maxRounds: 10 }, flow: [flow('ask:yes', 'agreed'), flow('ask:no', 'ask')] };

    await run(subject, executor);

    expect(executor.calls.filter((call) => call.node === 'ask').map((call) => call.inputs.prompt)).toEqual([
      'attempt 1', 'attempt 2', 'attempt 3',
    ]);
  });

  it('reads the latest output of a step that already ran, including its own', async () => {
    const executor = scriptedExecutor();
    const counting = procedure({
      start: 'count',
      budget: { maxRounds: 10 },
      nodes: [node('count', 'count', { limit: 4 }), node('show', 'echo'), node('end', 'finish', { outcome: 'ok' })],
      wires: [wire('count:count', 'count:previous')],
      flow: [flow('count:again', 'count'), flow('count:done', 'end')],
    });

    const result = await run(counting, executor);

    expect(executor.calls.filter((call) => call.node === 'count').map((call) => call.inputs.previous)).toEqual([undefined, 1, 2, 3]);
    expect(result.outputs.count).toEqual({ count: 4 });
  });

  it('gives a step its own last outputs, so it can build on them without a wire', async () => {
    const seen: unknown[] = [];
    const executor = scriptedExecutor({
      count: ({ previous }) => {
        seen.push(previous);
        const count = ((previous?.count as number | undefined) ?? 0) + 1;
        return { exit: count >= 3 ? 'done' : 'again', outputs: { count } };
      },
    });
    const counting = procedure({
      start: 'count',
      budget: { maxRounds: 10 },
      nodes: [node('count', 'count', { limit: 3 }), node('end', 'finish', { outcome: 'ok' })],
      flow: [flow('count:again', 'count'), flow('count:done', 'end')],
    });

    await run(counting, executor);

    expect(seen).toEqual([undefined, { count: 1 }, { count: 2 }]);
  });

  it('numbers every node execution in a run, so a result can name what it came from', async () => {
    const numbers: number[] = [];
    const executor = scriptedExecutor(
      { ask: ({ execution }) => { numbers.push(execution); return { exit: 'yes' }; } },
      { note: ({ execution }) => { numbers.push(execution); return { outputs: { text: 'hi' } }; } },
    );

    await run(askThenFinish, executor);

    expect(numbers).toEqual([1, 2]);
  });

  it('fails clearly when a step needs something that has not been produced yet', async () => {
    const early = procedure({
      start: 'ask',
      nodes: [node('first', 'echo'), node('ask', 'ask'), node('end', 'finish', { outcome: 'ok' })],
      wires: [wire('first:text', 'ask:prompt')],
      flow: [flow('ask:yes', 'first'), flow('ask:no', 'end'), flow('first:done', 'end')],
    });

    const result = await run(early, scriptedExecutor());

    expect(result).toMatchObject({ outcome: 'failed', reason: '"ask" needs "prompt", and "first.text" has not produced it yet' });
  });

  it('leaves an optional input empty when the value feeding it cannot be worked out yet', async () => {
    const executor = scriptedExecutor({ ask: () => ({ exit: 'yes', outputs: { reply: 'sure' } }) });
    const subject = procedure({
      start: 'first',
      budget: { maxRounds: 5 },
      nodes: [
        node('first', 'echo'),
        node('joined', 'join-text'),
        node('greeting', 'note', { text: 'hello' }),
        node('ask', 'ask'),
        node('end', 'finish', { outcome: 'ok' }),
      ],
      wires: [wire('ask:reply', 'joined:parts'), wire('joined:text', 'first:text'), wire('greeting:text', 'ask:prompt')],
      flow: [flow('first:done', 'ask'), flow('ask:yes', 'end'), flow('ask:no', 'first')],
    });

    const result = await run(subject, executor);

    expect(result.outcome).toBe('ok');
    expect(executor.calls.find((call) => call.node === 'first')?.inputs).toEqual({});
  });

  it('still fails a required input whose value cannot be worked out yet, naming what is missing', async () => {
    const subject = procedure({
      start: 'ask',
      nodes: [node('joined', 'join-text'), node('ask', 'ask'), node('first', 'echo'), node('end', 'finish', { outcome: 'ok' })],
      wires: [wire('first:text', 'joined:parts'), wire('joined:text', 'ask:prompt')],
      flow: [flow('ask:yes', 'first'), flow('ask:no', 'end'), flow('first:done', 'end')],
    });

    expect(await run(subject, scriptedExecutor())).toMatchObject({
      outcome: 'failed',
      reason: '"joined" needs "parts", and "first.text" has not produced it yet',
    });
  });

  it('adds up usage and stops when the budget runs out', async () => {
    const looping = { ...askThenFinish, budget: { maxRounds: 3 }, flow: [flow('ask:yes', 'agreed'), flow('ask:no', 'ask')] };
    const executor = scriptedExecutor({ ask: () => ({ exit: 'no', usage: { rounds: 1, totalTokens: 50 } }) });

    const result = await run(looping, executor);

    expect(result).toMatchObject({ outcome: 'exhausted', reason: 'used all 3 rounds' });
    expect(result.counters).toMatchObject({ rounds: 3, totalTokens: 150 });
  });

  it('still finishes after spending the last of its budget, and stops only a step that would spend more', async () => {
    const oneRound = { ...askThenFinish, budget: { maxRounds: 1 } };
    const again = { ...askThenFinish, budget: { maxRounds: 1 }, flow: [flow('ask:yes', 'agreed'), flow('ask:no', 'ask')] };
    const spendOnce = () => scriptedExecutor({ ask: () => ({ exit: 'no', usage: { rounds: 1 } }) });

    expect(await run(oneRound, scriptedExecutor({ ask: () => ({ exit: 'yes', usage: { rounds: 1 } }) }))).toMatchObject({ outcome: 'ok', reason: 'it agreed' });
    expect(await run(again, spendOnce())).toMatchObject({ outcome: 'exhausted', reason: 'used all 1 rounds', steps: 1 });
  });

  it('stops a procedure that never finishes after the step cap', async () => {
    const spinning = procedure({
      start: 'spin',
      nodes: [node('spin', 'echo'), node('end', 'finish', { outcome: 'ok' })],
      flow: [flow('spin:done', 'spin')],
    });

    expect(await run(spinning, scriptedExecutor(), { maxSteps: 25 })).toMatchObject({
      outcome: 'exhausted', reason: 'stopped after 25 steps without finishing', steps: 25,
    });
  });

  it('stops when asked to', async () => {
    const controller = new AbortController();
    const looping = { ...askThenFinish, flow: [flow('ask:yes', 'agreed'), flow('ask:no', 'ask')] };
    const executor = scriptedExecutor({
      ask: ({ run: context }) => {
        controller.abort();
        expect(context.signal?.aborted).toBe(true);
        return { exit: 'no' };
      },
    });

    expect(await run(looping, executor, { signal: controller.signal })).toMatchObject({ outcome: 'interrupted', reason: 'Stopped' });

    const withReason = new AbortController();
    withReason.abort('the run was cancelled');
    expect(await run(looping, scriptedExecutor({ ask: () => ({ exit: 'no' }) }), { signal: withReason.signal })).toMatchObject({
      outcome: 'interrupted', reason: 'the run was cancelled',
    });
  });

  it('turns an error inside a node into a failed run that names the node', async () => {
    const traces: NodeTrace[] = [];
    const executor = scriptedExecutor({ ask: () => { throw new Error('endpoint unreachable'); } });

    const result = await run(askThenFinish, executor, { onTrace: (trace) => traces.push(trace) });

    expect(result).toMatchObject({ outcome: 'failed', reason: '"ask" failed: endpoint unreachable' });
    expect(traces.at(-1)).toMatchObject({ node: 'ask', error: 'endpoint unreachable' });
  });

  it('fails when a step leaves through an exit it never declared', async () => {
    const result = await run(askThenFinish, scriptedExecutor({ ask: () => ({ exit: 'maybe' }) }));

    expect(result).toMatchObject({ outcome: 'failed', reason: '"ask" left through "maybe", which it does not declare' });
  });

  it('ends the run as interrupted when a step says it was interrupted', async () => {
    const result = await run(askThenFinish, scriptedExecutor({ ask: () => ({ interrupted: 'repeating itself' }) }));

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'repeating itself' });
  });

  describe('cleanup', () => {
    const withCleanup = (base: Procedure): Procedure => ({
      ...base,
      cleanup: 'release',
      nodes: [...base.nodes, node('release', 'echo'), node('released', 'finish', { outcome: 'ok' })],
      flow: [...base.flow, flow('release:done', 'released')],
    });

    it('runs after the procedure finishes, without changing its outcome', async () => {
      const executor = scriptedExecutor({ ask: () => ({ exit: 'no' }) });
      const result = await run(withCleanup(askThenFinish), executor);

      expect(result).toMatchObject({ outcome: 'failed', reason: 'it refused' });
      expect(executor.calls.map((call) => call.node)).toEqual(['greeting', 'ask', 'refused', 'release', 'released']);
      expect(executor.calls.find((call) => call.node === 'release')?.cleaningUp).toBe(true);
    });

    it('runs after an error, and after being stopped, without the stop signal', async () => {
      const failing = scriptedExecutor({ ask: () => { throw new Error('boom'); } });
      await run(withCleanup(askThenFinish), failing);
      expect(failing.calls.map((call) => call.node)).toContain('release');

      const controller = new AbortController();
      controller.abort();
      const stopped = scriptedExecutor({ release: ({ run: context }) => {
        expect(context.signal).toBeUndefined();
        return { exit: 'done' };
      } });
      const result = await run(withCleanup(askThenFinish), stopped, { signal: controller.signal });

      expect(result.outcome).toBe('interrupted');
      expect(stopped.calls.map((call) => call.node)).toEqual(['release', 'released']);
    });

    it('turns a finished run into a failed one when cleanup fails, and says so', async () => {
      const executor = scriptedExecutor({ ask: () => ({ exit: 'yes' }), release: () => { throw new Error('pod stuck'); } });

      expect(await run(withCleanup(askThenFinish), executor)).toMatchObject({
        outcome: 'failed', reason: 'it agreed; cleanup failed: "release" failed: pod stuck',
      });
    });
  });

  describe('groups', () => {
    const turn = group({
      id: 'turn',
      start: 'ask',
      nodes: [node('ask', 'ask')],
      inputs: [{ name: 'question', type: 'text', describe: 'Q', required: true, to: [{ node: 'ask', socket: 'prompt' }] }],
      outputs: [{ name: 'answer', type: 'text', describe: 'A', from: { node: 'ask', socket: 'reply' } }],
      exits: [
        { name: 'agreed', describe: 'yes', from: { node: 'ask', exit: 'yes' } },
        { name: 'refused', describe: 'no', from: { node: 'ask', exit: 'no' } },
      ],
    });

    const usingTurn = procedure({
      start: 't',
      nodes: [node('q', 'note', { text: 'ready?' }), groupNode('t', 'turn'), node('show', 'echo'), node('end', 'finish', { outcome: 'ok' })],
      wires: [wire('q:text', 't:question'), wire('t:answer', 'show:text')],
      flow: [flow('t:agreed', 'show'), flow('t:refused', 'end'), flow('show:done', 'end')],
      groups: [turn],
    });

    it('runs the nodes inside a group and carries values across its edge', async () => {
      const executor = scriptedExecutor({ ask: ({ inputs }) => ({ exit: 'yes', outputs: { reply: `yes to ${String(inputs.prompt)}` } }) });

      const result = await run(usingTurn, executor);

      expect(result.outcome).toBe('ok');
      expect(executor.calls.find((call) => call.node === 'show')?.inputs).toEqual({ text: 'yes to ready?' });
    });

    it('traces nodes inside a group back to the group node on the canvas', async () => {
      const traces: NodeTrace[] = [];
      await run(usingTurn, scriptedExecutor({ ask: () => ({ exit: 'no' }) }), { onTrace: (trace) => traces.push(trace) });

      expect(traces.find((trace) => trace.node === 't.ask')).toMatchObject({ origin: 't', exit: 'no' });
    });
  });

  describe('trace', () => {
    it('records every node that ran, in order, with what went in and what came out', async () => {
      const traces: NodeTrace[] = [];
      await run(askThenFinish, scriptedExecutor({ ask: () => ({ exit: 'yes', outputs: { reply: 'sure' } }) }), {
        onTrace: (trace) => traces.push(trace),
      });

      expect(traces.map(({ sequence, step, node: id, role, exit }) => ({ sequence, step, node: id, role, exit }))).toEqual([
        { sequence: 1, step: 1, node: 'greeting', role: 'value', exit: undefined },
        { sequence: 2, step: 1, node: 'ask', role: 'step', exit: 'yes' },
        { sequence: 3, step: 2, node: 'agreed', role: 'step', exit: undefined },
      ]);
      expect(traces[1]).toMatchObject({ inputs: { prompt: 'hello' }, outputs: { reply: 'sure' } });
    });

    it('keeps a very long value from swamping the record', async () => {
      const traces: NodeTrace[] = [];
      const huge = 'x'.repeat(10_000);
      await run(askThenFinish, scriptedExecutor({ ask: () => ({ exit: 'yes' }) }, { note: () => ({ outputs: { text: huge } }) }), {
        onTrace: (trace) => traces.push(trace),
      });

      const recorded = (traces[0]!.outputs as { text: string }).text;
      expect(recorded.length).toBeLessThan(4100);
      expect(recorded.endsWith('(10000 characters)')).toBe(true);
    });

    it('announces the run, each step entered and left, and how it ended', async () => {
      const bus = createEventBus();
      const seen: EngineEvent[] = [];
      bus.subscribe((event) => seen.push(event));

      await run(askThenFinish, scriptedExecutor({ ask: () => ({ exit: 'yes' }) }), { bus });

      expect(seen.map((event) => (event.type === 'node.exited' ? `${event.type}:${event.nodeId}:${event.via ?? ''}` : 'nodeId' in event ? `${event.type}:${event.nodeId}` : event.type))).toEqual([
        'run.started',
        'node.entered:ask',
        'node.exited:ask:yes',
        'node.entered:agreed',
        'node.exited:agreed:',
        'run.finished',
      ]);
    });
  });
});
