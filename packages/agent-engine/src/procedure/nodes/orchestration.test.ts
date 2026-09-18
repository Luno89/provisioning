import { describe, it, expect, vi } from 'vitest';
import { createOrchestrationNodes, REFUSED_CALL, type OrchestrationPorts } from './orchestration.js';
import { approveToolCalls, callTool, runToolCalls } from './tools.js';
import { delegate, fanOut, waitForPerson } from './control.js';
import type { BuiltInNode, NodeImplementation } from '../implementation.js';
import type { NodeRequest, RunContext, StepResult } from '../interpreter.js';
import { defaultSettings } from '../settings-schema.js';
import { createRunState } from '../../runtime/run.js';
import type { AgentDefinition } from '../../agent/agent.js';
import type { ModelReply, ToolResult } from '../values.js';

type Outcome = { exit?: string; outputs: Record<string, unknown>; usage?: Record<string, number> };

const persona = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  slug: 'worker', name: 'Worker', description: 'works', version: '1', prompt: 'work', procedure: 'tool-rounds',
  guidance: '', returns: '', failures: [], tools: ['read_file'], agents: ['research'], budget: {}, environment: {},
  ...over,
});

const reply = (calls: { id: string; name: string; arguments: string }[]): ModelReply => ({
  id: 'turn#5', content: '', thinking: '', finishReason: 'tool_calls', toolCalls: calls,
});

function ports(over: Partial<OrchestrationPorts> = {}): OrchestrationPorts & { [K in keyof OrchestrationPorts]: ReturnType<typeof vi.fn> } {
  return {
    runTool: vi.fn(async ({ call }) => ({ ok: true, digest: `ran ${call.name}`, content: `output of ${call.name}` })),
    runChild: vi.fn(async ({ agent, inputs }) => ({ runId: `child-${agent}`, agentId: agent, outcome: 'ok', outputs: { echoed: inputs } })),
    approve: vi.fn(async () => true),
    ask: vi.fn(async () => ({ answered: true, value: 'go ahead' })),
    ...over,
  } as never;
}

async function invoke(
  implementations: NodeImplementation[],
  built: BuiltInNode,
  over: { settings?: Record<string, unknown>; inputs?: Record<string, unknown>; run?: Partial<RunContext> } = {},
): Promise<Outcome & { events: unknown[] }> {
  const events: unknown[] = [];
  const implementation = implementations.find((candidate) => candidate.kind === built.definition.kind)!;
  const request: NodeRequest = {
    node: { id: 'here', kind: built.definition.kind, settings: { ...defaultSettings(built.definition.settings), ...(over.settings ?? {}) }, position: { x: 0, y: 0 } },
    origin: 'here',
    definition: built.definition,
    inputs: over.inputs ?? {},
    execution: 7,
    run: {
      identity: { runId: 'r', depth: 0, agentId: 'worker', loopId: 'p', loopVersion: '2', trigger: 'user' },
      launch: { ownerId: 'owner-1' },
      inputs: {},
      counters: createRunState(0).counters,
      budget: {},
      cleaningUp: false,
      emit: (event) => events.push(event),
      ...over.run,
    },
  };
  const result = (await implementation.run(request)) as StepResult & Outcome;
  return { ...(result as Outcome), events };
}

describe('approve tool calls', () => {
  const calls = reply([{ id: 'a', name: 'run_command', arguments: '{"command":"rm -rf build"}' }, { id: 'b', name: 'read_file', arguments: '{}' }]);
  const machine = { kind: 'machine', deviceId: 'd', deviceName: 'desk', egressMode: 'declared' };

  it('lets calls in a sandbox or on the platform through without asking', async () => {
    const p = ports();
    const outcome = await invoke(createOrchestrationNodes(p), approveToolCalls, { inputs: { reply: calls, environment: { kind: 'none', egress: false } } });

    expect(outcome.exit).toBe('approved');
    expect(outcome.outputs).toEqual({ approved: calls, refused: [] });
    expect(p.approve).not.toHaveBeenCalled();
  });

  it('asks about each call on someone\'s machine, keeps the approved ones and answers the refused ones', async () => {
    const p = ports({ approve: vi.fn(async ({ call }) => call.id === 'b') });
    const outcome = await invoke(createOrchestrationNodes(p), approveToolCalls, { inputs: { reply: calls, environment: machine } });

    expect(outcome.exit).toBe('approved');
    expect((outcome.outputs.approved as ModelReply).toolCalls.map((call) => call.id)).toEqual(['b']);
    expect(outcome.outputs.refused).toEqual([
      { forReply: 'turn#5', callId: 'a', name: 'run_command', ok: false, digest: REFUSED_CALL, content: REFUSED_CALL },
    ]);
    expect(outcome.events.map((event) => `${(event as { type: string }).type}:${(event as { callId: string }).callId}`)).toEqual([
      'tool.called:a', 'tool.result:a', 'tool.called:b',
    ]);
  });

  it('leaves through refused when nothing is allowed, and asks for every call when told to', async () => {
    const p = ports({ approve: vi.fn(async () => false) });
    const outcome = await invoke(createOrchestrationNodes(p), approveToolCalls, { settings: { ask: 'always' }, inputs: { reply: calls } });

    expect(outcome.exit).toBe('refused');
    expect(p.approve).toHaveBeenCalledTimes(2);
  });
});

describe('run tool calls', () => {
  it('runs tools where they live and starts delegates as child runs, in order, announcing each', async () => {
    const p = ports();
    const outcome = await invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: {
        persona: persona(),
        reply: reply([
          { id: 'a', name: 'read_file', arguments: '{"path":"x"}' },
          { id: 'b', name: 'research', arguments: '{"question":"why"}' },
        ]),
      },
    });

    expect(p.runTool).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'here', call: expect.objectContaining({ id: 'a' }) }));
    expect(p.runChild).toHaveBeenCalledWith(expect.objectContaining({ agent: 'research', inputs: { question: 'why' } }));
    expect((outcome.outputs.results as ToolResult[]).map((r) => [r.callId, r.forReply, r.ok, r.content])).toEqual([
      ['a', 'turn#5', true, 'output of read_file'],
      ['b', 'turn#5', true, '{"echoed":{"question":"why"}}'],
    ]);
    expect(outcome.usage).toEqual({ toolCalls: 1, childRuns: 1 });
    expect(outcome.events.map((event) => (event as { type: string }).type)).toEqual(['tool.called', 'tool.result', 'tool.called', 'tool.result']);
  });

  it('answers a delegate call whose arguments are not an object, and says when a child did not finish', async () => {
    const p = ports({ runChild: vi.fn(async () => ({ runId: 'c', agentId: 'research', outcome: 'exhausted', reason: 'used all 3 rounds', outputs: {} })) });
    const outcome = await invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: {
        persona: persona(),
        reply: reply([{ id: 'a', name: 'research', arguments: '"why"' }, { id: 'b', name: 'research', arguments: '{}' }]),
      },
    });

    expect((outcome.outputs.results as ToolResult[]).map((r) => [r.ok, r.content])).toEqual([
      [false, 'the arguments for "research" were not a JSON object'],
      [false, 'research did not finish: used all 3 rounds'],
    ]);
  });
});

describe('call tool, delegate, fan out and wait', () => {
  it('fills a tool\'s arguments from the wired values and text, and parses what comes back', async () => {
    const p = ports({ runTool: vi.fn(async () => ({ ok: true, digest: 'listed', content: '[{"id":"t1"}]' })) });
    const outcome = await invoke(createOrchestrationNodes(p), callTool, {
      settings: { tool: 'mark_done', args: '{"taskId":"{{values.item.id}}","evidence":"{{text}}"}' },
      inputs: { persona: persona(), values: { item: { id: 't-42' } }, text: 'tests pass' },
    });

    expect(p.runTool).toHaveBeenCalledWith(expect.objectContaining({
      call: { id: 'here#7', name: 'mark_done', arguments: '{"taskId":"t-42","evidence":"tests pass"}' },
    }));
    expect(outcome).toMatchObject({ exit: 'ok', outputs: { result: [{ id: 't1' }], text: '[{"id":"t1"}]' } });
  });

  it('hands a child only the inputs written for it, and leaves by how it ended', async () => {
    const p = ports({ runChild: vi.fn(async () => ({ runId: 'c', agentId: 'judge', outcome: 'failed', reason: 'unproven', outputs: {} })) });
    const outcome = await invoke(createOrchestrationNodes(p), delegate, {
      settings: { agent: 'judge', inputs: '{"work":"{{text}}"}' },
      inputs: { text: 'I fixed it' },
    });

    expect(p.runChild).toHaveBeenCalledWith(expect.objectContaining({ agent: 'judge', inputs: { work: 'I fixed it' } }));
    expect(outcome).toMatchObject({ exit: 'failed', outputs: { reason: 'judge did not finish: unproven' } });
  });

  it('fans out a few at a time and keeps every outcome in list order', async () => {
    let running = 0;
    let most = 0;
    const p = ports({
      runChild: vi.fn(async ({ inputs }) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((done) => setTimeout(done, 5));
        running -= 1;
        return { runId: `c${String(inputs.index)}`, agentId: 'executor', outcome: 'ok', outputs: { item: inputs.item } };
      }),
    });

    const outcome = await invoke(createOrchestrationNodes(p), fanOut, { settings: { agent: 'executor', maxParallel: 2 }, inputs: { items: ['a', 'b', 'c', 'd', 'e'] } });

    expect(most).toBe(2);
    expect((outcome.outputs.children as { outputs: { item: string } }[]).map((child) => child.outputs.item)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(outcome.usage).toEqual({ childRuns: 5 });
  });

  it('shows what was wired in as details under the message', async () => {
    const outcome = await invoke(createOrchestrationNodes(ports()), waitForPerson, { settings: { prompt: 'Accept the plan?' }, inputs: { details: '  1. write the file  ' } });

    expect(outcome.events).toEqual([{ type: 'notice', level: 'info', nodeId: 'here', message: 'Accept the plan?\n\n1. write the file' }]);
  });

  it('hands back a child\'s result as text, or everything it returned as JSON when that is not text', async () => {
    const summary = ports({ runChild: vi.fn(async () => ({ runId: 'c', agentId: 'planner', outcome: 'ok', outputs: { result: 'the plan' } })) as never });
    const structured = ports({ runChild: vi.fn(async () => ({ runId: 'c', agentId: 'judge', outcome: 'ok', outputs: { verdict: 'met' } })) as never });

    expect((await invoke(createOrchestrationNodes(summary), delegate, { settings: { agent: 'planner' } })).outputs.text).toBe('the plan');
    expect((await invoke(createOrchestrationNodes(structured), delegate, { settings: { agent: 'judge' } })).outputs.text).toBe('{"verdict":"met"}');
  });

  it('shows the message, waits, and leaves by whether anyone answered', async () => {
    const answered = await invoke(createOrchestrationNodes(ports()), waitForPerson, { settings: { prompt: 'Accept the plan?', timeoutMinutes: 5 } });
    const silent = ports({ ask: vi.fn(async () => ({ answered: false, reason: 'the run was cancelled' })) });
    const unanswered = await invoke(createOrchestrationNodes(silent), waitForPerson, { settings: { prompt: 'Accept the plan?', timeoutMinutes: 5 } });

    expect(answered).toMatchObject({ exit: 'answered', outputs: { answer: 'go ahead' } });
    expect(answered.events).toEqual([{ type: 'notice', level: 'info', nodeId: 'here', message: 'Accept the plan?' }]);
    expect(silent.ask).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300_000 }));
    expect(unanswered).toMatchObject({ exit: 'unanswered', outputs: { reason: 'the run was cancelled' } });
  });
});
