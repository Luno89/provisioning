import { describe, it, expect } from 'vitest';
import type { ToolContract } from '@koala/engine-core';
import {
  BUILT_IN_NODES,
  HOST_KINDS,
  ORCHESTRATION_KINDS,
  createOrchestrationNodes,
  WORKFLOW_IMPLEMENTATIONS,
  builtInCatalogue,
  buildContext,
  checkRepetition,
  checkStall,
  checkToolFailures,
  collect,
  condition,
  conversation,
  describeEnvironmentNode,
  describeOutputsNode,
  describeTools,
  finish,
  fitReplyBudget,
  handOffConversation,
  merge,
  runInput,
  text,
  trimToolResults,
  warnRunningOut,
  withdrawTools,
  readDecision,
} from './index.js';
import { implementationProblems, stepImplementation, valueImplementation, type BuiltInNode } from '../implementation.js';
import type { NodeRequest, RunContext, StepResult } from '../interpreter.js';
import { defaultSettings, settingsProblems } from '../settings-schema.js';
import { replyExit, toWireMessages, type ChatMessage, type ModelBinding, type ModelReply, type ToolResult } from '../values.js';
import { describeAsks, describeAvailable, describeEnvironment, describeWithheld } from '../../runtime/context.js';
import { createRunState } from '../../runtime/run.js';
import { SEEDED_AGENTS } from '../../agent/seeds.js';


type Outcome = { exit?: string; finish?: StepResult extends infer R ? R extends { finish: infer F } ? F : never : never; outputs: Record<string, unknown> };

const context = (over: Partial<RunContext> = {}): RunContext => ({
  identity: { runId: 'r', depth: 0, agentId: 'a', loopId: 'p', loopVersion: '1', trigger: 'user' },
  launch: { ownerId: 'owner-1' },
  handles: {},
  inputs: {},
  counters: createRunState(0).counters,
  budget: {},
  cleaningUp: false,
  emit: () => undefined,
  ...over,
});

async function invoke(
  built: BuiltInNode,
  over: { settings?: Record<string, unknown>; inputs?: Record<string, unknown>; previous?: Record<string, unknown>; run?: Partial<RunContext> } = {},
): Promise<Outcome> {
  const implementation = built.implementation;
  if (!implementation) throw new Error(`${built.definition.kind} has no workflow implementation`);
  const request: NodeRequest = {
    node: {
      id: built.definition.kind,
      kind: built.definition.kind,
      settings: { ...defaultSettings(built.definition.settings), ...(over.settings ?? {}) },
      position: { x: 0, y: 0 },
    },
    origin: built.definition.kind,
    definition: built.definition,
    inputs: over.inputs ?? {},
    ...(over.previous ? { previous: over.previous } : {}),
    execution: 1,
    run: context(over.run),
  };
  return (await implementation.run(request)) as Outcome;
}

const tool = (name: string, over: Partial<ToolContract> = {}): ToolContract => ({
  name,
  description: `does ${name}`,
  binding: 'platform',
  ...over,
});

const reply = (id: string, over: Partial<ModelReply> = {}): ModelReply => ({
  id,
  content: '',
  thinking: '',
  finishReason: 'stop',
  toolCalls: [],
  ...over,
});

const result = (forReply: string, callId: string, over: Partial<ToolResult> = {}): ToolResult => ({
  forReply,
  callId,
  name: 'read_file',
  ok: true,
  digest: 'fine',
  content: 'contents',
  ...over,
});

const binding: ModelBinding = { providerId: 'p', label: 'Tabby', contextTokens: 32_000, replyCeiling: 4096 };

describe('the built-in nodes', () => {
  it('form a usable catalogue', () => {
    expect(() => builtInCatalogue()).not.toThrow();
  });

  it('are each implemented exactly once, in the workflow or on the host', () => {
    const catalogue = builtInCatalogue();
    const orchestration = createOrchestrationNodes({
      runTool: async () => ({ ok: true, digest: '' }),
      runChild: async () => ({ runId: 'c', agentId: 'a', outcome: 'ok', outputs: {} }),
      approve: async () => true,
      ask: async () => ({ answered: true }),
    });
    const hostStandIns = HOST_KINDS.map((kind) => {
      const role = catalogue.get(kind)!.role;
      return role === 'step'
        ? stepImplementation(kind, () => ({ exit: 'done' }))
        : valueImplementation(kind, () => ({ outputs: {} }));
    });

    expect(implementationProblems(catalogue, [...WORKFLOW_IMPLEMENTATIONS, ...orchestration, ...hostStandIns])).toEqual([]);
    expect(ORCHESTRATION_KINDS).toEqual(orchestration.map((implementation) => implementation.kind));
    expect(HOST_KINDS).toEqual(expect.arrayContaining(['persona', 'choose-model', 'call-model', 'resolve-tools']));
    expect(HOST_KINDS).not.toContain('run-tool-calls');
  });

  it('only runs I/O-free nodes in the workflow', () => {
    for (const node of BUILT_IN_NODES) {
      expect(node.implementation !== undefined, node.definition.kind).toBe(node.definition.runs === 'workflow');
    }
  });

  it('start from default settings that pass their own checks and read sensibly', () => {
    for (const { definition } of BUILT_IN_NODES) {
      const settings = defaultSettings(definition.settings);
      const required = definition.settings.required ?? [];
      const filled = Object.fromEntries(required.filter((name) => settings[name] === undefined).map((name) => [name, name === 'tool' ? 'read_file' : 'x']));
      const usable = { ...settings, ...filled };

      expect(settingsProblems(definition.settings, usable), definition.kind).toEqual([]);
      expect(definition.summarize(usable).trim(), definition.kind).not.toBe('');
    }
  });
});

describe('reply exits', () => {
  it('prefers tool calls, then truncation, then silence, then an answer', () => {
    expect(replyExit(reply('1', { toolCalls: [{ id: 'c', name: 't', arguments: '{}' }], finishReason: 'length' }))).toBe('toolCalls');
    expect(replyExit(reply('1', { content: 'half a sent', finishReason: 'length' }))).toBe('truncated');
    expect(replyExit(reply('1', { content: '  ' }))).toBe('empty');
    expect(replyExit(reply('1', { content: 'done' }))).toBe('answered');
  });
});

describe('wire messages', () => {
  it('sends a reply\'s tool calls with it and answers each call by id, which the chat API requires', () => {
    expect(toWireMessages('be brief', [
      { role: 'user', content: 'read a' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }] },
      { role: 'tool', content: 'contents of a', toolCallId: 'call-1', name: 'read_file' },
      { role: 'assistant', content: 'a says hello' },
    ])).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'read a' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', content: 'contents of a', tool_call_id: 'call-1', name: 'read_file' },
      { role: 'assistant', content: 'a says hello' },
    ]);
  });
});

describe('input and model nodes', () => {
  it('hands on the message and inputs the run started with', async () => {
    expect((await invoke(runInput, { run: { inputs: { message: 'hi', path: 'a.ts' } } })).outputs).toEqual({
      message: 'hi',
      inputs: { message: 'hi', path: 'a.ts' },
    });
  });

  it('fits the reply cap to the real prompt, never above the ceiling or below the floor', async () => {
    const fit = async (system: string, messages: ChatMessage[] = []) =>
      (await invoke(fitReplyBudget, { inputs: { binding, system, messages } })).outputs;

    const empty = await fit('');
    const large = await fit('x'.repeat(100_000), [{ role: 'user', content: 'y'.repeat(12_000) }]);
    const huge = await fit('x'.repeat(400_000));

    expect(empty.maxTokens).toBe(4096);
    expect(large.maxTokens).toBe(32_000 - Math.ceil(112_000 / 4) - 1000);
    expect(huge.maxTokens).toBe(512);
    expect(large.pressure as number).toBeGreaterThan(empty.pressure as number);
  });
});

describe('context nodes', () => {
  it('withdraws tools only once the run reaches the round', async () => {
    const tools = [tool('search_web'), tool('write_file')];
    const settings = { afterRound: 3, tools: ['search_web'] };

    const early = await invoke(withdrawTools, { settings, inputs: { tools }, run: { counters: { ...createRunState(0).counters, rounds: 2 } } });
    const late = await invoke(withdrawTools, { settings, inputs: { tools }, run: { counters: { ...createRunState(0).counters, rounds: 3 } } });

    expect((early.outputs.tools as ToolContract[]).map((t) => t.name)).toEqual(['search_web', 'write_file']);
    expect((late.outputs.tools as ToolContract[]).map((t) => t.name)).toEqual(['write_file']);
    expect(late.outputs.withdrawn).toEqual(['search_web']);
  });

  it('describes the environment exactly as the prompt composer does', async () => {
    const none = await invoke(describeEnvironmentNode, {});
    const machine = await invoke(describeEnvironmentNode, {
      inputs: { environment: { kind: 'machine', deviceId: 'd', deviceName: 'desk', path: '/home/me', egressMode: 'declared' } },
    });

    expect(none.outputs.text).toBe(describeEnvironment({ kind: 'none', egress: false }));
    expect(machine.outputs.text).toBe(describeEnvironment({ kind: 'machine', deviceName: 'desk', root: '/home/me', egressMode: 'declared' }));
  });

  it('describes tools as available, withheld and asks, and says nothing when there is nothing', async () => {
    const offered = [tool('read_file', { usageGuidance: 'Read before you write.' }), tool('request_egress')];
    const withheld = [{ name: 'run_command', why: 'there is no terminal here' }];

    const described = await invoke(describeTools, { inputs: { offered, withheld } });

    expect(described.outputs.text).toBe([
      describeAvailable(offered),
      describeWithheld(withheld),
      describeAsks({ kind: 'none', egress: false }, offered),
    ].join('\n\n'));
    expect((await invoke(describeTools, {})).outputs.text).toBe('');
  });

  it('asks for the persona\'s declared outputs', async () => {
    const builder = SEEDED_AGENTS.find((agent) => agent.slug === 'agent-builder')!;

    expect((await invoke(describeOutputsNode, { inputs: { persona: builder } })).outputs.text)
      .toBe('When you are done, your answer must provide: agent, summary.');
  });

  it('says nothing about pacing until few rounds are left, then the most urgent note that applies', async () => {
    const notes = [{ atRemaining: 5, message: 'Start wrapping up.' }, { atRemaining: 2, message: 'Write it down NOW.' }];
    const at = async (rounds: number, maxRounds?: number) => (await invoke(warnRunningOut, {
      settings: { notes },
      run: { counters: { ...createRunState(0).counters, rounds }, budget: maxRounds === undefined ? {} : { maxRounds } },
    })).outputs.text;

    expect(await at(3)).toBe('');
    expect(await at(4, 10)).toBe('');
    expect(await at(6, 10)).toBe('[4 rounds left of 10. Start wrapping up.]');
    expect(await at(9, 10)).toBe('[1 round left of 10. Write it down NOW.]');
    expect(await at(10, 10)).toBe('');
  });

  it('joins sections in wire order, skipping empty ones', async () => {
    expect((await invoke(text, { settings: { text: 'Be brief.' } })).outputs.text).toBe('Be brief.');
    expect((await invoke(buildContext, { inputs: { sections: ['first', '', 'second'] } })).outputs.text).toBe('first\n\nsecond');
  });

  describe('conversation', () => {
    const call = { id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' };
    const other = { id: 'call-2', name: 'run_command', arguments: '{"command":"ls"}' };
    const talk = (inputs: Record<string, unknown>, previous?: Record<string, unknown>) =>
      invoke(conversation, { inputs: { opening: 'hello', ...inputs }, ...(previous ? { previous } : {}) });

    it('starts from the opening message', async () => {
      expect((await talk({})).outputs.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('adds a reply with its tool calls, then answers each call by id', async () => {
      const first = await talk({});
      const afterReply = await talk({
        replies: [reply('turn#3', { content: 'looking', toolCalls: [call] })],
        results: [[result('turn#3', 'call-1', { content: 'file a' })]],
      }, first.outputs);

      expect(afterReply.outputs.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'looking', toolCalls: [call] },
        { role: 'tool', content: 'file a', toolCallId: 'call-1', name: 'read_file' },
      ]);
    });

    it('never adds the same reply or the same results twice', async () => {
      const inputs = { replies: [reply('turn#3', { toolCalls: [call] })], results: [[result('turn#3', 'call-1')]] };
      const once = await talk(inputs);
      const twice = await talk(inputs, once.outputs);

      expect(twice.outputs.messages).toEqual(once.outputs.messages);
    });

    it('does not attach old results to a newer reply that made no calls', async () => {
      const withCalls = await talk({ replies: [reply('turn#3', { toolCalls: [call] })], results: [[result('turn#3', 'call-1')]] });
      const answered = await talk({ replies: [reply('turn#9', { content: 'all done' })], results: [[result('turn#3', 'call-1')]] }, withCalls.outputs);

      expect((answered.outputs.messages as ChatMessage[]).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });

    it('waits until every call in a reply has a result, then adds them in the order they were asked for', async () => {
      const both = reply('turn#3', { toolCalls: [call, other] });
      const partial = await talk({ replies: [both], results: [[result('turn#3', 'call-2', { name: 'run_command' })]] });
      const complete = await talk({
        replies: [both],
        results: [[result('turn#3', 'call-2', { name: 'run_command', content: 'ran' })], [result('turn#3', 'call-1', { content: 'refused', ok: false })]],
      }, partial.outputs);

      expect((partial.outputs.messages as ChatMessage[]).map((message) => message.role)).toEqual(['user', 'assistant']);
      expect((complete.outputs.messages as ChatMessage[]).slice(2)).toEqual([
        { role: 'tool', content: 'refused', toolCallId: 'call-1', name: 'read_file' },
        { role: 'tool', content: 'ran', toolCallId: 'call-2', name: 'run_command' },
      ]);
    });

    it('adds replies from several model steps in the order they were made', async () => {
      const added = await talk({ replies: [reply('second#12', { content: 'later' }), reply('first#4', { content: 'earlier' })] });

      expect((added.outputs.messages as ChatMessage[]).map((message) => message.content)).toEqual(['hello', 'earlier', 'later']);
    });
  });

  it('trims a long result from the front, keeping the end and saying how much went', async () => {
    const long = `${'a'.repeat(500)}ERROR at the end`;
    const trimmed = await invoke(trimToolResults, { settings: { maxChars: 100 }, inputs: { results: [result('r', 'c', { content: long })] } });
    const content = (trimmed.outputs.results as ToolResult[])[0]!.content;

    expect(content.startsWith('…[416 characters truncated from the start]\n')).toBe(true);
    expect(content.endsWith('ERROR at the end')).toBe(true);
  });

  describe('hand off conversation', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'Find out   why the build fails' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{}' }] },
      { role: 'tool', content: 'npm ERR! missing script: build', toolCallId: 'c1', name: 'run_command' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', content: '{"scripts":{}}', toolCallId: 'c2', name: 'read_file' },
      { role: 'assistant', content: 'The package has no build script.' },
    ];

    it('passes the history through while it fits', async () => {
      const handed = await invoke(handOffConversation, { inputs: { messages: history, binding } });

      expect(handed.exit).toBe('fits');
      expect(handed.outputs.messages).toBe(history);
    });

    it('summarises the goal and findings, and keeps a tail that never starts on an orphaned tool result', async () => {
      const tiny = { ...binding, contextTokens: 1100 };
      const handed = await invoke(handOffConversation, { settings: { tail: 2 }, inputs: { messages: history, binding: tiny } });
      const [notice, ...tail] = handed.outputs.messages as ChatMessage[];

      expect(handed.exit).toBe('handedOff');
      expect(notice!.role).toBe('user');
      expect(notice!.content).toContain('Find out why the build fails');
      expect(notice!.content).toContain('- read_file → {"scripts":{}}');
      expect(notice!.content).toContain('- run_command → npm ERR! missing script: build');
      expect(tail).toEqual(history.slice(-1));
    });
  });
});

describe('control nodes', () => {
  it('leaves a condition through true or false', async () => {
    const check = async (expression: string, value: unknown) => (await invoke(condition, { settings: { expression }, inputs: { value } })).exit;

    expect(await check('not empty(value)', ['a'])).toBe('true');
    expect(await check('len(value) > 3', ['a'])).toBe('false');
    expect(await check('counters.rounds == 0', undefined)).toBe('true');
  });

  it('refuses a condition that does not parse or reads something it cannot see', () => {
    const { check } = condition.definition;

    expect(check!({ expression: 'value ==' }, {})[0]).toMatch(/does not parse/);
    expect(check!({ expression: 'reply.content == "x"' }, {})).toEqual(['its expression reads "reply", but it can only read value, counters, inputs']);
    expect(check!({ expression: 'empty(value) and counters.rounds < 3' }, {})).toEqual([]);
  });

  it('merges child outcomes by strategy', async () => {
    const children = [
      { runId: '1', agentId: 'a', outcome: 'failed', outputs: {} },
      { runId: '2', agentId: 'b', outcome: 'ok', outputs: {} },
      { runId: '3', agentId: 'c', outcome: 'ok', outputs: {} },
    ];
    const kept = async (strategy: string) =>
      ((await invoke(merge, { settings: { strategy }, inputs: { children } })).outputs.merged as { runId: string }[]).map((child) => child.runId);

    expect(await kept('all')).toEqual(['1', '2', '3']);
    expect(await kept('ok')).toEqual(['2', '3']);
    expect(await kept('first-ok')).toEqual(['2']);
    expect(await kept('failed')).toEqual(['1']);
  });

  it('collects a list across runs of the step', async () => {
    const first = await invoke(collect, { inputs: { item: 'a' } });
    const second = await invoke(collect, { inputs: { item: 'b' }, previous: first.outputs });

    expect(second.outputs.items).toEqual(['a', 'b']);
  });

  it('adds each thing in a list when told to spread it, and a list as one entry otherwise', async () => {
    const spread = await invoke(collect, { settings: { spread: true }, inputs: { item: ['b', 'c'] }, previous: { items: ['a'] } });
    const whole = await invoke(collect, { inputs: { item: ['b', 'c'] }, previous: { items: ['a'] } });

    expect(spread.outputs.items).toEqual(['a', 'b', 'c']);
    expect(whole.outputs.items).toEqual(['a', ['b', 'c']]);
  });

  it('finishes with the written reason unless one is wired, and hands back a result', async () => {
    expect(await invoke(finish, { settings: { outcome: 'failed', reason: 'written' } })).toEqual({ finish: { outcome: 'failed', reason: 'written' } });
    expect(await invoke(finish, { settings: { outcome: 'failed', reason: 'written' }, inputs: { reason: 'what the check saw', result: 42 } })).toEqual({
      finish: { outcome: 'failed', reason: 'what the check saw' },
      outputs: { result: 42 },
    });
  });
});

describe('safety nodes', () => {
  it('trips on a model repeating itself, and judges each reply only once', async () => {
    let previous: Record<string, unknown> | undefined;
    const exits: (string | undefined)[] = [];
    for (let round = 1; round <= 5; round += 1) {
      const same = reply(`r${round}`, { thinking: 'I should read the config file again', toolCalls: [{ id: `c${round}`, name: 'read_file', arguments: '{"path":"config.json"}' }] });
      const outcome = await invoke(checkRepetition, { inputs: { reply: same }, ...(previous ? { previous } : {}) });
      exits.push(outcome.exit);
      previous = outcome.outputs;
    }

    expect(exits.at(-1)).toBe('tripped');
    expect(exits.slice(0, 3)).toEqual(['ok', 'ok', 'ok']);

    const again = await invoke(checkRepetition, { inputs: { reply: reply('r5') }, previous: previous! });
    expect((again.outputs.turns as unknown[]).length).toBe(5);
  });

  it('trips after enough silent replies in a row, and resets when the model does something', async () => {
    const step = async (id: string, content: string, previous?: Record<string, unknown>) =>
      invoke(checkStall, { inputs: { reply: reply(id, { content }) }, ...(previous ? { previous } : {}) });

    const one = await step('1', '');
    const spoke = await step('2', 'working on it', one.outputs);
    const two = await step('3', '', spoke.outputs);
    const three = await step('4', '', two.outputs);

    expect([one.exit, spoke.exit, two.exit, three.exit]).toEqual(['ok', 'ok', 'ok', 'tripped']);
    expect(three.outputs.reason).toBe('produced nothing for 2 rounds in a row');
  });

  it('counts failed tool calls across replies, resets on success, and counts each batch once', async () => {
    const batch = async (forReply: string, oks: boolean[], previous?: Record<string, unknown>) =>
      invoke(checkToolFailures, {
        inputs: { results: oks.map((ok, index) => result(forReply, `${forReply}-${index}`, { ok })) },
        ...(previous ? { previous } : {}),
      });

    const first = await batch('r1', [false, false]);
    const repeated = await batch('r1', [false, false], first.outputs);
    const tripped = await batch('r2', [true, false, false, false], repeated.outputs);

    expect(first.exit).toBe('ok');
    expect(repeated.outputs.consecutive).toBe(2);
    expect(tripped.exit).toBe('tripped');
    expect(tripped.outputs.reason).toBe('3 tool calls failed in a row');
  });
});

describe('reading a yes-or-no answer', () => {
  it('takes the first word of the first line, ignoring case and punctuation', () => {
    expect(readDecision('Yes.\nIt passed.')).toBe('yes');
    expect(readDecision('\n\n**NO** — nothing was tested')).toBe('no');
    expect(readDecision('unsure: the evidence is thin')).toBe('unsure');
  });

  it('is unsure about anything else, rather than guessing', () => {
    expect(readDecision('Probably yes')).toBe('unsure');
    expect(readDecision('')).toBe('unsure');
    expect(readDecision('yesterday it worked')).toBe('unsure');
  });
});

