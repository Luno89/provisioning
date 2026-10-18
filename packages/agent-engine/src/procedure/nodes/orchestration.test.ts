import { describe, it, expect, vi } from 'vitest';
import { createOrchestrationNodes, REFUSED_CALL, RUN_IN_WORKSPACE, type OrchestrationPorts } from './orchestration.js';
import { approveToolCalls, callTool, runToolCalls } from './tools.js';
import { askMachineAgent, delegate, externalAgent, fanOut, waitForPerson, whereItRuns } from './control.js';
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
      handles: {},
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

  const offered = [
    { name: 'delete_file', description: 'Delete a path', binding: 'environment', effect: 'write', destructive: true },
    { name: 'read_file', description: 'Read a file', binding: 'environment', effect: 'read' },
  ];
  const mixed = reply([{ id: 'a', name: 'delete_file', arguments: '{"path":"notes.md"}' }, { id: 'b', name: 'read_file', arguments: '{}' }]);

  it('asks about a call to a destructive tool wherever it runs, and lets the rest of the reply through unasked', async () => {
    const p = ports({ approve: vi.fn(async () => false) });
    const outcome = await invoke(createOrchestrationNodes(p), approveToolCalls, { inputs: { reply: mixed, offered, environment: { kind: 'none', egress: false } } });

    expect(p.approve).toHaveBeenCalledTimes(1);
    expect(p.approve.mock.calls[0]![0].call.name).toBe('delete_file');
    expect(outcome.exit).toBe('approved');
    expect((outcome.outputs.approved as ModelReply).toolCalls.map((call) => call.id)).toEqual(['b']);
    expect((outcome.outputs.refused as { callId: string }[]).map((result) => result.callId)).toEqual(['a']);
  });

  it('runs a destructive call once a person allows it', async () => {
    const p = ports({ approve: vi.fn(async () => true) });
    const outcome = await invoke(createOrchestrationNodes(p), approveToolCalls, { inputs: { reply: mixed, offered } });

    expect((outcome.outputs.approved as ModelReply).toolCalls.map((call) => call.id)).toEqual(['a', 'b']);
  });

  const sandbox = { kind: 'sandbox', id: 'pod', workspace: { runId: 'tree-t1' }, capabilities: { kind: 'sandbox' } };
  const withPlatform = [...offered, { name: 'delete_tree', description: 'Delete a tree', binding: 'platform', effect: 'write', destructive: true }];
  const inAndOut = reply([{ id: 'a', name: 'delete_file', arguments: '{"path":"notes.md"}' }, { id: 'c', name: 'delete_tree', arguments: '{"treeId":"t1"}' }]);

  it('never asks about a call that runs inside the run\'s sandbox, destructive or not, but still asks about one that reaches outside it', async () => {
    const p = ports({ approve: vi.fn(async () => true), sandboxCallsUnasked: vi.fn(() => true) });
    await invoke(createOrchestrationNodes(p), approveToolCalls, { inputs: { reply: inAndOut, offered: withPlatform, environment: sandbox } });

    expect(p.approve.mock.calls.map(([request]) => request.call.name)).toEqual(['delete_tree']);
  });

  it('keeps asking about destructive sandbox calls in a run that started before sandbox calls went unasked', async () => {
    const p = ports({ approve: vi.fn(async () => true), sandboxCallsUnasked: vi.fn(() => false) });
    await invoke(createOrchestrationNodes(p), approveToolCalls, { inputs: { reply: inAndOut, offered: withPlatform, environment: sandbox } });

    expect(p.approve.mock.calls.map(([request]) => request.call.name)).toEqual(['delete_file', 'delete_tree']);
  });

  it('still asks about every sandbox call when told to always ask', async () => {
    const p = ports({ approve: vi.fn(async () => true), sandboxCallsUnasked: vi.fn(() => true) });
    await invoke(createOrchestrationNodes(p), approveToolCalls, { settings: { ask: 'always' }, inputs: { reply: inAndOut, offered: withPlatform, environment: sandbox } });

    expect(p.approve).toHaveBeenCalledTimes(2);
  });

  it('asks about nothing, destructive or not, when told never to', async () => {
    const p = ports();
    await invoke(createOrchestrationNodes(p), approveToolCalls, { settings: { ask: 'never' }, inputs: { reply: mixed, offered, environment: machine } });

    expect(p.approve).not.toHaveBeenCalled();
  });
});

describe('run tool calls', () => {
  it('runs tools where they live and starts delegates as child runs, answering in the order they were asked', async () => {
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
    expect(outcome.events.filter((event) => (event as { type: string }).type === 'tool.called')).toHaveLength(2);
  });

  it('hands on what a tool made and what a child run made, each on its own call', async () => {
    const written = { kind: 'file' as const, workspace: 'conversation-c1', path: 'notes.md' };
    const found = { kind: 'file' as const, workspace: 'conversation-c1', path: 'research/r1/findings.md' };
    const p = ports({
      runTool: vi.fn(async () => ({ ok: true, digest: 'wrote notes.md', artifacts: [written] })),
      runChild: vi.fn(async () => ({ runId: 'c', agentId: 'research', outcome: 'ok', outputs: {}, artifacts: [found] })),
    });
    const outcome = await invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: { persona: persona(), reply: reply([{ id: 'a', name: 'write_file', arguments: '{}' }, { id: 'b', name: 'research', arguments: '{}' }]) },
    });

    expect((outcome.outputs.results as ToolResult[]).map((result) => [result.callId, result.artifacts])).toEqual([['a', [written]], ['b', [found]]]);
    expect(outcome.events.filter((event) => (event as { type: string }).type === 'tool.result').map((event) => (event as { artifacts?: unknown }).artifacts)).toEqual(expect.arrayContaining([[written], [found]]));
  });

  it('tells a hand-off\'s run which call started it, and hands on what that run did under the call', async () => {
    const steps = [{ callId: 'c1', name: 'search_web', ok: true, digest: '3 results' }];
    const p = ports({ runChild: vi.fn(async () => ({ runId: 'run-1-research-1', agentId: 'research', outcome: 'ok', outputs: {}, steps })) });
    const outcome = await invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: { persona: persona(), reply: reply([{ id: 'b', name: 'research', arguments: '{}' }]) },
    });

    const child = { runId: 'run-1-research-1', agentId: 'research', outcome: 'ok', steps };
    expect(p.runChild).toHaveBeenCalledWith(expect.objectContaining({ callId: 'b', agent: 'research' }));
    expect((outcome.outputs.results as ToolResult[])[0]!.child).toEqual(child);
    expect(outcome.events.find((event) => (event as { type: string }).type === 'tool.result')).toMatchObject({ callId: 'b', child });
  });

  it('starts every hand-off in a reply at once, so none waits for another to finish', async () => {
    const started: string[] = [];
    const finishers: (() => void)[] = [];
    const p = ports({
      runChild: vi.fn(async ({ inputs }: { inputs: Record<string, unknown> }) => {
        started.push(String(inputs.question));
        await new Promise<void>((resolve) => finishers.push(resolve));
        return { runId: `c-${String(inputs.question)}`, agentId: 'research', outcome: 'ok', outputs: { answer: String(inputs.question) } };
      }),
    });
    const running = invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: {
        persona: persona(),
        reply: reply([
          { id: 'a', name: 'research', arguments: '{"question":"one"}' },
          { id: 'b', name: 'research', arguments: '{"question":"two"}' },
          { id: 'c', name: 'research', arguments: '{"question":"three"}' },
        ]),
      },
    });

    await vi.waitFor(() => expect(started).toEqual(['one', 'two', 'three']));
    for (const finish of finishers.reverse()) finish();
    const outcome = await running;

    expect((outcome.outputs.results as ToolResult[]).map((result) => result.callId)).toEqual(['a', 'b', 'c']);
    expect(outcome.usage).toEqual({ toolCalls: 0, childRuns: 3 });
  });

  it('runs calls that only read together, and holds a call that changes something until every call before it is done', async () => {
    const log: string[] = [];
    const finishers = new Map<string, () => void>();
    const p = ports({
      runTool: vi.fn(async ({ call }: { call: { id: string; name: string } }) => {
        log.push(`start ${call.id}`);
        await new Promise<void>((resolve) => finishers.set(call.id, resolve));
        log.push(`end ${call.id}`);
        return { ok: true, digest: `ran ${call.name}`, content: `output of ${call.name}` };
      }),
      readsTogether: vi.fn(() => true),
    });
    const offered = [
      { name: 'read_file', effect: 'read' },
      { name: 'search_web', effect: 'read' },
      { name: 'write_file', effect: 'write' },
    ];
    const running = invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: {
        persona: persona({ tools: ['read_file', 'search_web', 'write_file'] }),
        offered,
        reply: reply([
          { id: 'a', name: 'read_file', arguments: '{}' },
          { id: 'b', name: 'search_web', arguments: '{}' },
          { id: 'c', name: 'write_file', arguments: '{}' },
          { id: 'd', name: 'read_file', arguments: '{}' },
        ]),
      },
    });

    await vi.waitFor(() => expect(log).toEqual(['start a', 'start b']));
    finishers.get('b')!();
    await vi.waitFor(() => expect(log).toEqual(['start a', 'start b', 'end b']));
    finishers.get('a')!();
    await vi.waitFor(() => expect(log.at(-1)).toBe('start c'));
    finishers.get('c')!();
    await vi.waitFor(() => expect(log.at(-1)).toBe('start d'));
    finishers.get('d')!();
    const outcome = await running;

    expect(log).toEqual(['start a', 'start b', 'end b', 'end a', 'start c', 'end c', 'start d', 'end d']);
    expect((outcome.outputs.results as ToolResult[]).map((result) => result.callId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('runs every call on its own, in order, for a run that began before reads ran together', async () => {
    let running = 0;
    let most = 0;
    const p = ports({
      runTool: vi.fn(async ({ call }: { call: { name: string } }) => {
        running += 1;
        most = Math.max(most, running);
        await Promise.resolve();
        running -= 1;
        return { ok: true, digest: `ran ${call.name}`, content: '' };
      }),
      readsTogether: vi.fn(() => false),
    });
    await invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: {
        persona: persona(),
        offered: [{ name: 'read_file', effect: 'read' }],
        reply: reply([{ id: 'a', name: 'read_file', arguments: '{}' }, { id: 'b', name: 'read_file', arguments: '{}' }]),
      },
    });

    expect(most).toBe(1);
  });

  it('starts hand-offs one at a time when the host says a run began before they started together', async () => {
    let running = 0;
    let most = 0;
    const p = { ...ports(), handOffsTogether: () => false, runChild: vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await Promise.resolve();
      running -= 1;
      return { runId: 'c', agentId: 'research', outcome: 'ok' as const, outputs: {} };
    }) };
    const outcome = await invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: { persona: persona(), reply: reply([{ id: 'a', name: 'research', arguments: '{}' }, { id: 'b', name: 'research', arguments: '{}' }]) },
    });

    expect(most).toBe(1);
    expect(outcome.usage).toEqual({ toolCalls: 0, childRuns: 2 });
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

  it('reads its list from an items reference over the wired values, whole value kept intact', async () => {
    const leaves = [{ leafId: 'l1' }, { leafId: 'l2' }, { leafId: 'l3' }];
    const p = ports({ runChild: vi.fn(async ({ inputs }) => ({ runId: `c${inputs.index}`, agentId: 'executor', outcome: 'ok', outputs: { item: inputs.item } })) });

    const outcome = await invoke(createOrchestrationNodes(p), fanOut, {
      settings: { agent: 'executor', maxParallel: 3, items: '{{values.ready}}' },
      inputs: { values: { ready: leaves, other: 'not the list' } },
    });

    expect((p.runChild as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    expect((outcome.outputs.children as { outputs: { item: unknown } }[]).map((child) => child.outputs.item)).toEqual(leaves);

    // A reference that comes back as something other than a list fans out over nothing.
    const scalar = await invoke(createOrchestrationNodes(ports({ runChild: vi.fn(async () => ({ runId: 'c', agentId: 'e', outcome: 'ok', outputs: {} })) })), fanOut, {
      settings: { agent: 'executor', items: '{{values.ready}}' },
      inputs: { values: { ready: 'not a list' } },
    });
    expect(scalar.outputs.children).toEqual([]);
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

  it('offers the answers to choose from when it has them, and asks for one of them', async () => {
    const p = ports();
    const outcome = await invoke(createOrchestrationNodes(p), waitForPerson, { settings: { prompt: 'Install it?', choices: ['Install it', 'Do not install'] } });

    expect(outcome.events).toEqual([{ type: 'notice', level: 'info', nodeId: 'here', message: 'Install it?', choices: ['Install it', 'Do not install'] }]);
    expect(p.ask).toHaveBeenCalledWith(expect.objectContaining({ choices: ['Install it', 'Do not install'] }));
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

describe('children work where their parent works', () => {
  const sandbox = { kind: 'sandbox', id: 'engine-tree-t1', workspace: { runId: 'tree-t1' }, capabilities: { kind: 'sandbox', lifecycle: 'invocation' } } as never;
  const machine = { kind: 'machine', deviceId: 'd1', deviceName: 'desk', egressMode: 'declared' } as never;
  const none = { kind: 'none', egress: false } as never;
  const handedTo = (p: ReturnType<typeof ports>) => (p.runChild as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => (request as { environment?: unknown }).environment);

  it('hands a delegate called as a tool the sandbox its caller is working in', async () => {
    const p = ports();
    await invoke(createOrchestrationNodes(p), runToolCalls, {
      inputs: { persona: persona(), environment: sandbox, reply: reply([{ id: 'a', name: 'research', arguments: '{}' }]) },
    });

    expect(handedTo(p)).toEqual([sandbox]);
  });

  it('keeps a machine or an empty environment to the caller, so the child finds its own', async () => {
    const onMachine = ports();
    await invoke(createOrchestrationNodes(onMachine), runToolCalls, {
      inputs: { persona: persona(), environment: machine, reply: reply([{ id: 'a', name: 'research', arguments: '{}' }]) },
    });
    const withNothing = ports();
    await invoke(createOrchestrationNodes(withNothing), runToolCalls, {
      inputs: { persona: persona(), environment: none, reply: reply([{ id: 'a', name: 'research', arguments: '{}' }]) },
    });

    expect(handedTo(onMachine)).toEqual([undefined]);
    expect(handedTo(withNothing)).toEqual([undefined]);
  });

  it('hands every fanned-out child and every delegate the sandbox the run was launched in', async () => {
    const launch = { ownerId: 'owner-1', environment: sandbox };

    const fanned = ports();
    await invoke(createOrchestrationNodes(fanned), fanOut, { settings: { agent: 'leaf-judge' }, inputs: { items: ['l1', 'l2'] }, run: { launch } });
    const delegated = ports();
    await invoke(createOrchestrationNodes(delegated), delegate, { settings: { agent: 'judge', inputs: '{}' }, run: { launch } });

    expect(handedTo(fanned)).toEqual([sandbox, sandbox]);
    expect(handedTo(delegated)).toEqual([sandbox]);
  });

  it('narrows the sandbox to the worktree an item names, so each fanned-out child works in its own', async () => {
    const launch = { ownerId: 'owner-1', environment: sandbox };
    const p = ports();
    await invoke(createOrchestrationNodes(p), fanOut, {
      settings: { agent: 'leaf-judge' },
      inputs: { items: [{ leafId: 'a', worktree: 'trees/a' }, { leafId: 'b', worktree: 'trees/b' }, { leafId: 'c' }] },
      run: { launch },
    });

    expect(handedTo(p).map((environment) => (environment as { worktree?: string }).worktree)).toEqual(['trees/a', 'trees/b', undefined]);
    expect(handedTo(p).every((environment) => (environment as { id: string }).id === 'engine-tree-t1')).toBe(true);
  });

  it('hands every child the workspace wired in rather than its own, narrowed to each item\'s worktree', async () => {
    const tree = { kind: 'sandbox', id: 'engine-shared-wired', workspace: { runId: 'tree-t1' }, capabilities: { kind: 'sandbox', lifecycle: 'invocation' } } as never;
    const p = ports();
    await invoke(createOrchestrationNodes(p), fanOut, {
      settings: { agent: 'worker' },
      inputs: { items: [{ leafId: 'a', worktree: 'trees/a' }, { leafId: 'b' }], environment: tree },
    });

    expect(handedTo(p).map((environment) => [(environment as { id: string }).id, (environment as { worktree?: string }).worktree])).toEqual([
      ['engine-shared-wired', 'trees/a'],
      ['engine-shared-wired', undefined],
    ]);
  });

  it('hands each child the item\'s own fields as its inputs when told to, and { item, index } otherwise', async () => {
    const spread = ports();
    await invoke(createOrchestrationNodes(spread), fanOut, { settings: { agent: 'planner', itemAsInputs: true }, inputs: { items: [{ leafId: 'a', mode: 'replan' }] } });
    const wrapped = ports();
    await invoke(createOrchestrationNodes(wrapped), fanOut, { settings: { agent: 'planner' }, inputs: { items: [{ leafId: 'a' }] } });

    expect(vi.mocked(spread.runChild).mock.calls[0]![0].inputs).toEqual({ leafId: 'a', mode: 'replan' });
    expect(vi.mocked(wrapped.runChild).mock.calls[0]![0].inputs).toEqual({ item: { leafId: 'a' }, index: 0 });
  });

  it('fans out without an environment when the run was not handed one', async () => {
    const p = ports();
    await invoke(createOrchestrationNodes(p), fanOut, { settings: { agent: 'leaf-judge' }, inputs: { items: ['l1'] } });

    expect(handedTo(p)).toEqual([undefined]);
  });
});

describe('handing a task to an external agent', () => {
  const machine = { kind: 'machine', deviceId: 'laptop', deviceName: 'Laptop', path: 'shop', egressMode: 'open' } as const;
  const identity = { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.0' };

  it('gives it the brief, the context and its mode on the run\'s machine, and leaves by how its turn ended', async () => {
    const runExternal = vi.fn(async () => ({ outcome: 'finished' as const, stopReason: 'end_turn', text: 'Built the module.', identity, sessionId: 's-1' }));
    const p = ports({ runExternal } as never);
    const outcome = await invoke(createOrchestrationNodes(p), externalAgent, {
      settings: { agent: 'antigravity', mode: 'auto_edit' },
      inputs: { brief: ' Build delivery_labels. ', prompt: 'You build Odoo modules.', context: 'Odoo 20.', memories: ' ' },
      run: { launch: { ownerId: 'owner-1', environment: machine } },
    });
    expect(runExternal).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'here', agent: 'antigravity', brief: 'Build delivery_labels.', context: 'You build Odoo modules.\n\nOdoo 20.', mode: 'auto_edit', environment: machine }));
    expect(outcome).toMatchObject({ exit: 'finished', outputs: { text: 'Built the module.', stopReason: 'end_turn', identity, sessionId: 's-1' }, usage: { childRuns: 1 } });
  });

  it('runs the machine\'s agent of the same name as the run when none is set', async () => {
    const runExternal = vi.fn(async () => ({ outcome: 'finished' as const, stopReason: 'end_turn', text: 'ok', identity, sessionId: 's' }));
    await invoke(createOrchestrationNodes(ports({ runExternal } as never)), externalAgent, { inputs: { brief: 'go', environment: machine } });
    expect(runExternal).toHaveBeenCalledWith(expect.objectContaining({ agent: 'worker' }));
  });

  it('says why it stopped or failed', async () => {
    const stopped = ports({ runExternal: vi.fn(async () => ({ outcome: 'stopped' as const, stopReason: 'cancelled', text: 'Half', identity, sessionId: 's-2', reason: 'the run was cancelled' })) } as never);
    expect(await invoke(createOrchestrationNodes(stopped), externalAgent, { settings: { agent: 'antigravity' }, inputs: { brief: 'go', environment: machine } }))
      .toMatchObject({ exit: 'stopped', outputs: { stopReason: 'cancelled', reason: 'the run was cancelled' } });
    const died = ports({ runExternal: vi.fn(async () => ({ outcome: 'failed' as const, text: '', reason: 'antigravity exited (1) during the turn' })) } as never);
    expect(await invoke(createOrchestrationNodes(died), externalAgent, { settings: { agent: 'antigravity' }, inputs: { brief: 'go', environment: machine } }))
      .toMatchObject({ exit: 'failed', outputs: { reason: 'antigravity exited (1) during the turn' } });
  });

  it('fails without starting anything when the host cannot, the run has no machine, or there is no task', async () => {
    const runExternal = vi.fn();
    expect(await invoke(createOrchestrationNodes(ports()), externalAgent, { settings: { agent: 'antigravity' }, inputs: { brief: 'go', environment: machine } }))
      .toMatchObject({ exit: 'failed', outputs: { reason: 'this host cannot run an external agent' } });
    expect(await invoke(createOrchestrationNodes(ports({ runExternal } as never)), externalAgent, { settings: { agent: 'antigravity' }, inputs: { brief: 'go', environment: { kind: 'none', egress: false } } }))
      .toMatchObject({ exit: 'failed', outputs: { reason: 'antigravity works on a person\'s machine, and no machine was picked for this run' } });
    expect(await invoke(createOrchestrationNodes(ports({ runExternal } as never)), externalAgent, { settings: { agent: 'antigravity' }, inputs: { brief: '  ', environment: machine } }))
      .toMatchObject({ exit: 'failed', outputs: { reason: 'there was no task to hand antigravity' } });
    expect(runExternal).not.toHaveBeenCalled();
  });
});

describe('an agent on a machine working on a workspace', () => {
  const identity = { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.0' };
  const workspace = {
    kind: 'sandbox', id: 'engine-tree-t1', worktree: 'trees/l1',
    workspace: { runId: 'tree-t1', ownerId: 'owner-1', agent: 'executor', image: 'koala/base', provides: [], lifetimeMs: 1, cpu: '1', memory: '1Gi', egress: [], env: [], egressMode: 'declared', repository: 'the project\'s repository' },
    capabilities: { kind: 'sandbox', lifecycle: 'persistent', languages: [] },
  } as const;
  const ownSandbox = {
    kind: 'sandbox', id: 'engine-run-1',
    workspace: { runId: 'run-1', ownerId: 'owner-1', agent: 'research', image: 'koala/base', provides: [], cpu: '1', memory: '1Gi', egress: [], env: [], egressMode: 'declared' },
    capabilities: { kind: 'sandbox', lifecycle: 'invocation', languages: [] },
  } as const;
  const onMachine = { launch: { ownerId: 'owner-1', modelId: 'machine:laptop:antigravity:pro' } };

  it('leaves through machine when a machine was picked for the run or the agent runs on one, and through model otherwise', async () => {
    const nodes = createOrchestrationNodes(ports());
    expect(await invoke(nodes, whereItRuns, { run: onMachine })).toMatchObject({ exit: 'machine', outputs: { machine: 'machine:laptop:antigravity:pro' } });
    expect(await invoke(nodes, whereItRuns, { inputs: { persona: persona({ model: { endpointId: 'machine:desk:antigravity' } }) } })).toMatchObject({ exit: 'machine', outputs: { machine: 'machine:desk:antigravity' } });
    expect(await invoke(nodes, whereItRuns, { run: { launch: { ownerId: 'owner-1', modelId: 'tabby' } } })).toMatchObject({ exit: 'model' });
  });

  it('hands the run\'s machine the workspace, serves run_in_workspace in place of the environment\'s tools, and runs it as a command in the workspace', async () => {
    let served: { name: string }[] = [];
    let ran: { ok: boolean; content: string } | undefined;
    const runExternal = vi.fn(async (request: { tools?: { name: string }[]; callTool?: (call: { callId: string; name: string; arguments: string }) => Promise<{ ok: boolean; content: string }> }) => {
      served = request.tools ?? [];
      ran = await request.callTool!({ callId: 'c1', name: RUN_IN_WORKSPACE, arguments: '{"command":"odoo-check"}' });
      return { outcome: 'finished' as const, stopReason: 'end_turn', text: 'Checked.', identity, sessionId: 's' };
    });
    const p = ports({ runExternal } as never);
    const outcome = await invoke(createOrchestrationNodes(p), externalAgent, {
      inputs: {
        brief: 'Build the label.', environment: workspace, persona: persona({ tools: ['read_file'] }),
        tools: [{ name: 'read_file', description: 'reads', binding: 'environment' }, { name: 'search_memories', description: 'searches', binding: 'none' }],
      },
      run: onMachine,
    });

    expect(outcome.exit).toBe('finished');
    expect(runExternal).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'antigravity', model: 'pro', workspace,
      environment: expect.objectContaining({ kind: 'machine', deviceId: 'laptop' }),
    }));
    expect(served.map((tool) => tool.name)).toEqual(['search_memories', RUN_IN_WORKSPACE]);
    expect(p.runTool).toHaveBeenCalledWith(expect.objectContaining({
      call: { id: 'c1', name: 'run_command', arguments: '{"command":"odoo-check"}' },
      persona: expect.objectContaining({ tools: ['read_file', 'run_command'] }),
      environment: workspace,
    }));
    expect(ran).toEqual({ ok: true, content: 'output of run_command' });
  });

  it('runs the persona\'s served tools in the workspace too, as a model\'s call would', async () => {
    const runExternal = vi.fn(async (request: { callTool?: (call: { callId: string; name: string; arguments: string }) => Promise<{ ok: boolean; content: string }> }) => {
      await request.callTool!({ callId: 'c2', name: 'record_verdict', arguments: '{"verdict":"met"}' });
      return { outcome: 'finished' as const, stopReason: 'end_turn', text: 'Met.', identity, sessionId: 's' };
    });
    const p = ports({ runExternal } as never);
    await invoke(createOrchestrationNodes(p), externalAgent, {
      inputs: { brief: 'Judge it.', environment: workspace, persona: persona({ tools: ['record_verdict'] }), tools: [{ name: 'record_verdict', description: 'records', binding: 'none' }] },
      run: onMachine,
    });
    expect(p.runTool).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ name: 'record_verdict' }), environment: workspace }));
  });

  it('lets the agent work in its own folder when the run\'s sandbox keeps no repository, running Koala\'s tools in the sandbox and offering no run_in_workspace', async () => {
    let served: { name: string }[] = [];
    const runExternal = vi.fn(async (request: { tools?: { name: string }[]; callTool?: (call: { callId: string; name: string; arguments: string }) => Promise<{ ok: boolean; content: string }> }) => {
      served = request.tools ?? [];
      await request.callTool!({ callId: 'c3', name: 'search_web', arguments: '{"query":"TabbyAPI"}' });
      expect(await request.callTool!({ callId: 'c4', name: RUN_IN_WORKSPACE, arguments: '{"command":"ls"}' })).toEqual({ ok: false, content: `${RUN_IN_WORKSPACE} is not one of the tools offered here` });
      return { outcome: 'finished' as const, stopReason: 'end_turn', text: 'Found it.', identity, sessionId: 's' };
    });
    const p = ports({ runExternal } as never);
    await invoke(createOrchestrationNodes(p), externalAgent, {
      inputs: { brief: 'Find the port.', environment: ownSandbox, persona: persona({ tools: ['search_web', 'run_command'] }), tools: [{ name: 'search_web', description: 'searches', binding: 'none' }, { name: 'run_command', description: 'runs', binding: 'environment' }] },
      run: onMachine,
    });

    expect(served.map((tool) => tool.name)).toEqual(['search_web']);
    expect(runExternal.mock.calls[0]).not.toHaveProperty('0.workspace');
    expect(runExternal).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ kind: 'machine', deviceId: 'laptop' }) }));
    expect(p.runTool).toHaveBeenCalledTimes(1);
    expect(p.runTool).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ name: 'search_web' }), environment: ownSandbox }));
  });

  it('puts an agent with no environment at all on the run\'s machine, and runs Koala\'s tools with no environment, as it does for a bare machine', async () => {
    const callOnce = async (request: { callTool?: (call: { callId: string; name: string; arguments: string }) => Promise<{ ok: boolean; content: string }> }) => {
      await request.callTool!({ callId: 'c5', name: 'search_memories', arguments: '{}' });
      return { outcome: 'finished' as const, stopReason: 'end_turn', text: 'ok', identity, sessionId: 's' };
    };
    const tools = [{ name: 'search_memories', description: 'searches', binding: 'none' }];
    for (const environment of [{ kind: 'none', egress: false }, { kind: 'machine', deviceId: 'laptop', deviceName: 'Laptop', egressMode: 'open' }]) {
      const runExternal = vi.fn(callOnce);
      const p = ports({ runExternal } as never);
      await invoke(createOrchestrationNodes(p), externalAgent, { inputs: { brief: 'Look.', environment, persona: persona({ tools: ['search_memories'] }), tools }, run: onMachine });
      expect(runExternal).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ kind: 'machine', deviceId: 'laptop' }) }));
      expect(p.runTool).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ name: 'search_memories' }), environment: undefined }));
    }
  });

  it('fails without starting anything when a workspace run has no machine picked', async () => {
    const runExternal = vi.fn();
    expect(await invoke(createOrchestrationNodes(ports({ runExternal } as never)), externalAgent, { settings: { agent: 'antigravity' }, inputs: { brief: 'go', environment: workspace } }))
      .toMatchObject({ exit: 'failed', outputs: { reason: 'antigravity works on a person\'s machine, and no machine was picked for this run' } });
    expect(runExternal).not.toHaveBeenCalled();
  });

  it('asks the machine\'s agent a yes-or-no question in a session of its own, and leaves by its answer', async () => {
    const runExternal = vi.fn(async () => ({ outcome: 'finished' as const, stopReason: 'end_turn', text: 'Yes. The verdict accepts the work.', identity, sessionId: 's' }));
    const outcome = await invoke(createOrchestrationNodes(ports({ runExternal } as never)), askMachineAgent, {
      settings: { question: 'Does this verdict say the work is done?' }, inputs: { text: { verdict: 'pass' } }, run: onMachine,
    });
    expect(outcome).toMatchObject({ exit: 'yes', outputs: { decision: 'yes', why: 'Yes. The verdict accepts the work.' } });
    expect(runExternal).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'antigravity', model: 'pro',
      brief: expect.stringContaining('Question: Does this verdict say the work is done?\n\nText:\n{\n  "verdict": "pass"\n}'),
      environment: expect.objectContaining({ kind: 'machine', deviceId: 'laptop' }),
    }));
    expect(runExternal.mock.calls[0]).not.toHaveProperty('0.tools');

    const died = ports({ runExternal: vi.fn(async () => ({ outcome: 'failed' as const, text: '', reason: 'the laptop is off' })) } as never);
    expect(await invoke(createOrchestrationNodes(died), askMachineAgent, { inputs: { text: 'x' }, run: onMachine })).toMatchObject({ exit: 'failed', outputs: { reason: 'the laptop is off' } });
    expect(await invoke(createOrchestrationNodes(died), askMachineAgent, { inputs: { text: 'x' } })).toMatchObject({ exit: 'failed', outputs: { reason: 'no machine was picked for this run, so there is no agent there to ask' } });
  });


  it('hands it the opening a model would get when it is given inputs but no message', async () => {
    const runExternal = vi.fn(async () => ({ outcome: 'finished' as const, stopReason: 'end_turn', text: 'Met.', identity, sessionId: 's' }));
    await invoke(createOrchestrationNodes(ports({ runExternal } as never)), externalAgent, {
      inputs: { brief: '', conversation: [{ role: 'user', content: 'work: wrote label.txt\nexpected: label.txt says Axial Concepts' }], environment: workspace, persona: persona() },
      run: onMachine,
    });
    expect(runExternal).toHaveBeenCalledWith(expect.objectContaining({ brief: 'work: wrote label.txt\nexpected: label.txt says Axial Concepts' }));
    expect(runExternal.mock.calls[0]).not.toHaveProperty('0.context');
  });
});
