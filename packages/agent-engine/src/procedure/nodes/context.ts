import type { WithheldTool } from '@koala/engine-core';
import { clampDualBoundary, extractContinuityState, DEFAULT_COMPACTION_CONFIG } from '@koala/context-engine';
import type { AgentDefinition } from '../../agent/agent.js';
import { contextPressure } from '../../model/sampling.js';
import type { BudgetConfig } from '@koala/harness-types';
import {
  describeAsks,
  describeAvailable,
  describeEnvironment,
  describeOutputs,
  describeWithheld,
  joinSections,
  type ResolvedEnvironment,
} from '../../runtime/context.js';
import { defineNode } from '../definition.js';
import { describeHandles } from '../handled.js';
import { stepImplementation, valueImplementation, type BuiltInNode } from '../implementation.js';
import { NO_SETTINGS } from '../settings-schema.js';
import {
  promptCharacters,
  type ChatMessage,
  type EnvironmentValue,
  type ModelBinding,
  type ModelReply,
  type ToolResult,
  type ToolSet,
} from '../values.js';
import { DEFAULT_CONTEXT_MARGIN } from './model.js';
import { collapse, numberOf, textOf, textsOf } from './read.js';

export const NO_ENVIRONMENT: EnvironmentValue = { kind: 'none', egress: false };

export function resolvedEnvironment(environment: EnvironmentValue | undefined): ResolvedEnvironment {
  const value = environment ?? NO_ENVIRONMENT;
  if (value.kind === 'sandbox') return { kind: 'sandbox', workspace: value.workspace };
  if (value.kind === 'machine') {
    return { kind: 'machine', deviceName: value.deviceName, root: value.path ?? '.', egressMode: value.egressMode };
  }
  return { kind: 'none', egress: value.egress, ...(value.bases ? { bases: value.bases } : {}) };
}

export const resolveTools: BuiltInNode = {
  definition: defineNode({
    kind: 'resolve-tools',
    title: 'Resolve Tools',
    category: 'context',
    describe: 'Works out which tools the model can use on this call: what the persona is granted, including the personas it may delegate to, narrowed to what the environment can support and what this step allows. Everything left out is listed with the reason.',
    role: 'value',
    inputs: [
      { name: 'persona', type: 'persona', describe: 'Whose grants to start from.', required: true },
      { name: 'delegates', type: 'json', describe: 'The personas it may delegate to, offered as tools.' },
      { name: 'environment', type: 'environment', describe: 'What the run can reach. Nothing wired means no environment.' },
    ],
    outputs: [
      { name: 'offered', type: 'toolSet', describe: 'The tools to offer the model.' },
      { name: 'withheld', type: 'json', describe: 'Granted tools that are not offered, each with why.' },
    ],
    exits: [],
    settings: {
      type: 'object',
      properties: {
        offer: {
          type: 'string',
          title: 'Offer',
          describe: '"granted" offers everything that works here, "none" offers nothing, "chosen" offers only the tools listed below.',
          enum: ['granted', 'none', 'chosen'],
          default: 'granted',
        },
        chosen: {
          type: 'array',
          title: 'Chosen tools',
          describe: 'Used when Offer is "chosen".',
          items: { type: 'string', minLength: 1 },
          default: [],
        },
      },
    },
    runs: 'activity',
    idempotent: true,
    summarize: (settings) => {
      const offer = textOf(settings, 'offer', 'granted');
      if (offer === 'none') return 'offers no tools';
      if (offer === 'chosen') return `offers only ${textsOf(settings, 'chosen').join(', ') || 'nothing yet'}`;
      return 'offers every granted tool that works here';
    },
    check: (settings) =>
      textOf(settings, 'offer', 'granted') === 'chosen' && textsOf(settings, 'chosen').length === 0
        ? ['offers only chosen tools, but none are chosen']
        : [],
  }),
};

export const withdrawTools: BuiltInNode = {
  definition: defineNode({
    kind: 'withdraw-tools',
    title: 'Withdraw Tools',
    category: 'context',
    describe: 'Stops offering some tools once the run has used a number of rounds — for example taking away search once it is time to write up.',
    role: 'value',
    inputs: [{ name: 'tools', type: 'toolSet', describe: 'The tools that would otherwise be offered.', required: true }],
    outputs: [
      { name: 'tools', type: 'toolSet', describe: 'The tools still offered.' },
      { name: 'withdrawn', type: 'json', describe: 'The names taken away this round, if any.' },
    ],
    exits: [],
    settings: {
      type: 'object',
      required: ['afterRound', 'tools'],
      properties: {
        afterRound: { type: 'integer', title: 'After round', describe: 'Withdraw from this round on.', minimum: 0, default: 10 },
        tools: { type: 'array', title: 'Tools', describe: 'Which tools to take away.', items: { type: 'string', minLength: 1 }, default: [] },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) =>
      `withdraws ${textsOf(settings, 'tools').join(', ') || 'nothing'} after round ${numberOf(settings, 'afterRound', 10)}`,
  }),
  implementation: valueImplementation('withdraw-tools', ({ node, inputs, run }) => {
    const tools = inputs.tools as ToolSet;
    if (run.counters.rounds < numberOf(node.settings, 'afterRound', 10)) {
      return { outputs: { tools, withdrawn: [] } };
    }
    const names = new Set(textsOf(node.settings, 'tools'));
    return {
      outputs: {
        tools: tools.filter((tool) => !names.has(tool.name)),
        withdrawn: tools.filter((tool) => names.has(tool.name)).map((tool) => tool.name),
      },
    };
  }),
};

export const describeEnvironmentNode: BuiltInNode = {
  definition: defineNode({
    kind: 'describe-environment',
    title: 'Describe Environment',
    category: 'context',
    describe: 'Tells the model where it is working: a sandbox and its workspace, a registered machine, or no environment at all — and, when it has none, which bases its delegates could work in.',
    role: 'value',
    inputs: [
      { name: 'environment', type: 'environment', describe: 'What the run can reach. Nothing wired means no environment.' },
      { name: 'delegates', type: 'json', describe: 'The personas it may delegate to.' },
    ],
    outputs: [{ name: 'text', type: 'text', describe: 'The environment section of the prompt.' }],
    exits: [],
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => 'describes where the model is working',
  }),
  implementation: valueImplementation('describe-environment', ({ inputs }) => ({
    outputs: {
      text: describeEnvironment(
        resolvedEnvironment(inputs.environment as EnvironmentValue | undefined),
        (inputs.delegates as AgentDefinition[] | undefined) ?? [],
      ),
    },
  })),
};

export const describeProcedure: BuiltInNode = {
  definition: defineNode({
    kind: 'describe-procedure',
    title: 'Describe Procedure',
    category: 'context',
    describe: 'Tells the model which steps the procedure carries out for it, so it does not do them again. Reads every Call Tool step marked as the procedure\'s job.',
    role: 'value',
    inputs: [],
    outputs: [{ name: 'text', type: 'text', describe: 'The section naming what happens around the model.' }],
    exits: [],
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => 'says what the procedure does for the model',
  }),
  implementation: valueImplementation('describe-procedure', ({ run }) => ({
    outputs: { text: describeHandles(run.handles) },
  })),
};

export const describeTools: BuiltInNode = {
  definition: defineNode({
    kind: 'describe-tools',
    title: 'Describe Tools',
    category: 'context',
    describe: 'Lists the tools the model can use right now with their guidance, the ones it cannot and why, and what to do when it cannot proceed.',
    role: 'value',
    inputs: [
      { name: 'offered', type: 'toolSet', describe: 'The tools being offered.' },
      { name: 'withheld', type: 'json', describe: 'The tools not offered, with reasons.' },
      { name: 'environment', type: 'environment', describe: 'Decides what the model is told about reaching the network.' },
    ],
    outputs: [{ name: 'text', type: 'text', describe: 'The tools section of the prompt.' }],
    exits: [],
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => 'lists the tools, what is withheld, and what to do when stuck',
  }),
  implementation: valueImplementation('describe-tools', ({ inputs }) => {
    const offered = (inputs.offered as ToolSet | undefined) ?? [];
    const withheld = (inputs.withheld as WithheldTool[] | undefined) ?? [];
    const environment = resolvedEnvironment(inputs.environment as EnvironmentValue | undefined);

    return {
      outputs: {
        text: joinSections([describeAvailable(offered), describeWithheld(withheld), describeAsks(environment, offered)]),
      },
    };
  }),
};

export const describeOutputsNode: BuiltInNode = {
  definition: defineNode({
    kind: 'describe-outputs',
    title: 'Describe Outputs',
    category: 'context',
    describe: 'Tells the model what its final answer has to contain, from the outputs the persona declares.',
    role: 'value',
    inputs: [{ name: 'persona', type: 'persona', describe: 'Whose declared outputs to ask for.', required: true }],
    outputs: [{ name: 'text', type: 'text', describe: 'The outputs section of the prompt, or nothing if none are declared.' }],
    exits: [],
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => 'asks for the outputs the persona declares',
  }),
  implementation: valueImplementation('describe-outputs', ({ inputs }) => ({
    outputs: { text: describeOutputs(inputs.persona as AgentDefinition) },
  })),
};

export interface PacingNote {
  atRemaining: number;
  message: string;
}

export function pacingText(notes: readonly PacingNote[], rounds: number, maxRounds: number | undefined): string {
  if (maxRounds === undefined) return '';
  const remaining = maxRounds - rounds;
  if (remaining <= 0) return '';

  const note = notes
    .filter((candidate) => remaining <= candidate.atRemaining)
    .sort((a, b) => a.atRemaining - b.atRemaining)[0];
  if (!note) return '';

  return `[${remaining} round${remaining === 1 ? '' : 's'} left of ${maxRounds}. ${note.message}]`;
}

export const warnRunningOut: BuiltInNode = {
  definition: defineNode({
    kind: 'warn-running-out',
    title: 'Warn Running Out',
    category: 'context',
    describe: 'Adds a note when the run is close to its round budget, so the model wraps up instead of being cut off mid-task. The note with the fewest rounds that still applies wins.',
    role: 'value',
    inputs: [],
    outputs: [{ name: 'text', type: 'text', describe: 'The note, or nothing while there is time.' }],
    exits: [],
    settings: {
      type: 'object',
      required: ['notes'],
      properties: {
        notes: {
          type: 'array',
          title: 'Notes',
          describe: 'Each note applies once this many rounds or fewer are left.',
          items: {
            type: 'object',
            required: ['atRemaining', 'message'],
            properties: {
              atRemaining: { type: 'integer', title: 'Rounds left', minimum: 1 },
              message: { type: 'string', title: 'Message', minLength: 1, multiline: true },
            },
          },
          default: [],
        },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => {
      const count = Array.isArray(settings.notes) ? settings.notes.length : 0;
      return count === 0 ? 'has no notes yet' : `warns at ${count} point${count === 1 ? '' : 's'} before the budget runs out`;
    },
  }),
  implementation: valueImplementation('warn-running-out', ({ node, run }) => ({
    outputs: {
      text: pacingText(
        (Array.isArray(node.settings.notes) ? node.settings.notes : []) as PacingNote[],
        run.counters.rounds,
        run.budget.maxRounds,
      ),
    },
  })),
};

export const text: BuiltInNode = {
  definition: defineNode({
    kind: 'text',
    title: 'Text',
    category: 'context',
    describe: 'A piece of text you write, to put anywhere text is taken — usually a section of the system prompt.',
    role: 'value',
    inputs: [],
    outputs: [{ name: 'text', type: 'text', describe: 'The text as written.' }],
    exits: [],
    settings: {
      type: 'object',
      properties: { text: { type: 'string', title: 'Text', multiline: true, default: '' } },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => {
      const written = collapse(textOf(settings, 'text'));
      return written ? (written.length > 60 ? `${written.slice(0, 60)}…` : written) : 'empty';
    },
  }),
  implementation: valueImplementation('text', ({ node }) => ({ outputs: { text: textOf(node.settings, 'text') } })),
};

export const buildContext: BuiltInNode = {
  definition: defineNode({
    kind: 'build-context',
    title: 'Build Context',
    category: 'context',
    describe: 'Joins sections into the system prompt, in the order they are wired, leaving out any that are empty.',
    role: 'value',
    inputs: [{ name: 'sections', type: 'text', describe: 'The sections, top to bottom.', required: true, many: true }],
    outputs: [{ name: 'text', type: 'text', describe: 'The system prompt.' }],
    exits: [],
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => 'joins sections into the system prompt',
  }),
  implementation: valueImplementation('build-context', ({ inputs }) => ({
    outputs: { text: joinSections(inputs.sections as string[]) },
  })),
};

export interface ConversationRound {
  reply: ModelReply;
  results: ToolResult[];
}

interface ConversationState {
  messages: ChatMessage[];
  replies: string[];
  answered: string[];
  rounds: ConversationRound[];
}

const executionOf = (reply: ModelReply): number => Number(reply.id.split('#').pop()) || 0;

const labelled = (name: string, value: unknown): string =>
  (typeof value === 'string' ? `${name}: ${value}` : `${name}:\n${JSON.stringify(value, null, 2)}`);

export function openingWith(message: string, given: Readonly<Record<string, unknown>> | undefined): string {
  const named = Object.entries(given ?? {}).filter(([name, value]) => name !== 'message'
    && value !== undefined
    && value !== null
    && value !== ''
    && !(typeof value === 'string' && message.includes(value)));

  if (named.length === 0) return message;
  const said = named.map(([name, value]) => labelled(name, value)).join('\n\n');
  return message.trim() ? `${message}\n\n${said}` : said;
}

export function extendConversation(
  previous: ConversationState | undefined,
  opening: string,
  replies: readonly ModelReply[],
  results: readonly (readonly ToolResult[])[],
  history: readonly ChatMessage[] = [],
): ConversationState {
  const state: ConversationState = previous
    ? {
      messages: [...previous.messages],
      replies: [...previous.replies],
      answered: [...previous.answered],
      rounds: (previous.rounds ?? []).map((round) => ({ reply: round.reply, results: [...round.results] })),
    }
    : { messages: [...history, { role: 'user', content: opening }], replies: [], answered: [], rounds: [] };

  const byCall = new Map<string, ToolResult>();
  for (const batch of results) {
    for (const result of batch) byCall.set(JSON.stringify([result.forReply, result.callId]), result);
  }

  const unseen = [...new Map(replies.map((reply) => [reply.id, reply])).values()]
    .filter((reply) => !state.replies.includes(reply.id))
    .sort((a, b) => executionOf(a) - executionOf(b));

  const known = [...unseen];
  for (const reply of replies) {
    if (state.replies.includes(reply.id) && !known.some((entry) => entry.id === reply.id)) known.push(reply);
  }

  for (const reply of unseen) {
    state.messages.push({
      role: 'assistant',
      content: reply.content,
      ...(reply.toolCalls.length > 0 ? { toolCalls: reply.toolCalls } : {}),
    });
    state.replies.push(reply.id);
    state.rounds.push({ reply, results: [] });
  }

  // Every tool result this run brought in is filed under the round that asked for it,
  // so a later save can remember what the tools did in the middle of a multi-round turn.
  for (const batch of results) {
    for (const result of batch) {
      const round = state.rounds.find((candidate) => candidate.reply.id === result.forReply);
      if (round && !round.results.some((x) => x.callId === result.callId)) round.results.push(result);
    }
  }

  for (const reply of known.sort((a, b) => executionOf(a) - executionOf(b))) {
    if (reply.toolCalls.length === 0 || state.answered.includes(reply.id)) continue;
    const answers = reply.toolCalls.map((call) => byCall.get(JSON.stringify([reply.id, call.id])));
    if (answers.some((answer) => answer === undefined)) continue;

    for (const answer of answers as ToolResult[]) {
      state.messages.push({ role: 'tool', content: answer.content, toolCallId: answer.callId, name: answer.name });
    }
    state.answered.push(reply.id);
  }

  return state;
}

export const conversation: BuiltInNode = {
  definition: defineNode({
    kind: 'conversation',
    title: 'Conversation',
    category: 'context',
    describe: 'Keeps the message history. It starts from whatever earlier thread is wired in, then the opening message and whatever named inputs the run was given that the opening does not already say; each time it runs it adds any new replies in the order they were made, each with the tool calls it asked for, and once every call in a reply has a result it adds those results, answering each call by id. Nothing is added twice.',
    role: 'step',
    inputs: [
      { name: 'opening', type: 'text', describe: 'The first user message.', required: true },
      { name: 'given', type: 'json', describe: 'The named inputs the run was started with. Each one the opening does not already say is added to it, labelled, so the model sees everything the run was given.' },
      { name: 'history', type: 'messages', describe: 'What was said in earlier runs. Wired from Load Conversation, it goes in front of the opening so the model sees the whole thread. Nothing wired means the conversation starts here.' },
      { name: 'replies', type: 'reply', describe: 'The model\'s replies, from any number of model steps.', many: true },
      { name: 'results', type: 'toolResults', describe: 'Tool results, including refusals, from any number of steps.', many: true },
    ],
    outputs: [
      { name: 'messages', type: 'messages', describe: 'The conversation so far.' },
      { name: 'rounds', type: 'json', describe: 'Every model round the conversation has seen, each with its own reply and the tool results it drew back — the shape of a multi-round turn, so a save can remember the calls made in the middle of it, not only the final words.' },
    ],
    exits: [{ name: 'done', describe: 'Always.' }],
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => 'keeps the message history',
  }),
  implementation: stepImplementation('conversation', ({ inputs, previous }) => {
    const state = extendConversation(
      previous as ConversationState | undefined,
      openingWith(inputs.opening as string, inputs.given as Record<string, unknown> | undefined),
      (inputs.replies as ModelReply[] | undefined) ?? [],
      (inputs.results as ToolResult[][] | undefined) ?? [],
      (inputs.history as ChatMessage[] | undefined) ?? [],
    );
    return { exit: 'done', outputs: { ...state } };
  }),
};

const looksStructured = (content: string): boolean => /^[[{]/.test(content.trimStart());

export const clampToolResult = (content: string, maxChars: number, headRatio?: number): string => {
  if (content.length <= maxChars) return content;
  const cut = content.length - maxChars;

  if (headRatio !== undefined) {
    return clampDualBoundary(content, { maxChars, headRatio });
  }

  return looksStructured(content)
    ? `${content.slice(0, maxChars)}\n…[${cut} characters truncated from the end]`
    : `…[${cut} characters truncated from the start]\n${content.slice(-maxChars)}`;
};

export const trimToolResults: BuiltInNode = {
  definition: defineNode({
    kind: 'trim-tool-results',
    title: 'Trim Tool Results',
    category: 'context',
    describe: 'Caps how much of each tool result the model sees, and says how much was cut. It keeps the end of ordinary output, where errors and totals usually are, and the start of anything structured, where a JSON result says what it is.',
    role: 'value',
    inputs: [{ name: 'results', type: 'toolResults', describe: 'The full results.', required: true }],
    outputs: [{ name: 'results', type: 'toolResults', describe: 'The results as the model will see them.' }],
    exits: [],
    settings: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', title: 'Characters kept', minimum: 100, maximum: 200_000, default: DEFAULT_COMPACTION_CONFIG.maxOutputChars },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `keeps ${numberOf(settings, 'maxChars', DEFAULT_COMPACTION_CONFIG.maxOutputChars)} characters of each result`,
  }),
  implementation: valueImplementation('trim-tool-results', ({ node, inputs }) => {
    const maxChars = numberOf(node.settings, 'maxChars', DEFAULT_COMPACTION_CONFIG.maxOutputChars);
    return {
      outputs: {
        results: (inputs.results as ToolResult[]).map((result) => ({ ...result, content: clampToolResult(result.content, maxChars) })),
      },
    };
  }),
};

export interface HandOffSettings {
  at: number;
  tail: number;
  goalChars: number;
  discoveries: number;
  discoveryChars: number;
}

export function handOff(
  messages: readonly ChatMessage[],
  settings?: Partial<HandOffSettings> | undefined,
): ChatMessage[] {
  const goalChars = settings?.goalChars ?? DEFAULT_COMPACTION_CONFIG.goalChars;
  const discoveries = settings?.discoveries ?? DEFAULT_COMPACTION_CONFIG.maxDiscoveries;
  const discoveryChars = settings?.discoveryChars ?? DEFAULT_COMPACTION_CONFIG.discoveryChars;
  const tailCount = settings?.tail ?? DEFAULT_COMPACTION_CONFIG.liveTailTurns;

  const state = extractContinuityState(messages, {
    goalChars,
    maxDiscoveries: discoveries,
    discoveryChars,
  });

  const found = state.recentDiscoveries;
  const directives = state.cumulativeUserDirectives;
  const negative = state.negativeKnowledge;
  const files = [...state.filesCreated, ...state.filesModified];

  let tail = messages.slice(-tailCount);
  while (tail[0]?.role === 'tool') tail = tail.slice(1);

  const noticeLines = [
    'Earlier messages in this conversation were summarised to fit the context window.',
    '',
    '**What this conversation is about**',
    state.goal || '(not recorded)',
  ];

  if (directives.length > 0) {
    noticeLines.push('', '**Cumulative User Directives & Constraints**', ...directives.map((d) => `- ${d}`));
  }

  if (files.length > 0) {
    noticeLines.push('', '**Files Touched**', ...files.slice(0, 10).map((f) => `- ${f}`));
  }

  if (negative.length > 0) {
    noticeLines.push('', '**Errors & Negative Knowledge (Do Not Repeat)**', ...negative.slice(0, 5).map((e) => `- ${e}`));
  }

  if (found.length > 0) {
    noticeLines.push('', '**What the tools found**', ...found.map((line) => `- ${line}`));
  }

  noticeLines.push(
    '',
    'Carry on from here. If you need detail that was in the elided messages, call the tool again rather than guessing — the results above are a summary, not the full output.',
  );

  return [{ role: 'user', content: noticeLines.join('\n') }, ...tail];
}

export const handOffConversation: BuiltInNode = {
  definition: defineNode({
    kind: 'hand-off-conversation',
    title: 'Hand Off Conversation',
    category: 'context',
    describe: 'When the prompt fills the context window past a threshold, replaces the history with a summary — what the conversation is about and what the tools found — plus the last few messages. Otherwise passes the history through.',
    role: 'step',
    inputs: [
      { name: 'messages', type: 'messages', describe: 'The full history.', required: true },
      { name: 'binding', type: 'modelBinding', describe: 'The model, for its context window.', required: true },
      { name: 'system', type: 'text', describe: 'The system prompt, which also takes up the window.' },
    ],
    outputs: [{ name: 'messages', type: 'messages', describe: 'The history to send.' }],
    exits: [
      { name: 'fits', describe: 'The history fits and was passed through.' },
      { name: 'handedOff', describe: 'The history was replaced with a summary and a tail.' },
    ],
    settings: {
      type: 'object',
      properties: {
        at: { type: 'number', title: 'Hand off at', describe: 'How full the window may get, from 0 to 1.', minimum: 0.05, maximum: 1, default: DEFAULT_COMPACTION_CONFIG.softThreshold },
        tail: { type: 'integer', title: 'Messages kept', minimum: 1, default: DEFAULT_COMPACTION_CONFIG.liveTailTurns },
        goalChars: { type: 'integer', title: 'Goal length', minimum: 50, default: DEFAULT_COMPACTION_CONFIG.goalChars },
        discoveries: { type: 'integer', title: 'Findings kept', minimum: 0, default: DEFAULT_COMPACTION_CONFIG.maxDiscoveries },
        discoveryChars: { type: 'integer', title: 'Finding length', minimum: 20, default: DEFAULT_COMPACTION_CONFIG.discoveryChars },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `summarises the history once the window is ${Math.round(numberOf(settings, 'at', DEFAULT_COMPACTION_CONFIG.softThreshold) * 100)}% full`,
  }),
  implementation: stepImplementation('hand-off-conversation', ({ node, inputs }) => {
    const messages = inputs.messages as ChatMessage[];
    const binding = inputs.binding as ModelBinding;
    const system = (inputs.system as string | undefined) ?? '';
    const pressure = contextPressure(
      { contextTokens: binding.contextTokens, contextMargin: DEFAULT_CONTEXT_MARGIN } as BudgetConfig,
      promptCharacters(system, messages),
      binding.contextTokens,
    );

    if (pressure < numberOf(node.settings, 'at', DEFAULT_COMPACTION_CONFIG.softThreshold)) return { exit: 'fits', outputs: { messages } };

    return {
      exit: 'handedOff',
      outputs: {
        messages: handOff(messages, {
          at: numberOf(node.settings, 'at', DEFAULT_COMPACTION_CONFIG.softThreshold),
          tail: numberOf(node.settings, 'tail', DEFAULT_COMPACTION_CONFIG.liveTailTurns),
          goalChars: numberOf(node.settings, 'goalChars', DEFAULT_COMPACTION_CONFIG.goalChars),
          discoveries: numberOf(node.settings, 'discoveries', DEFAULT_COMPACTION_CONFIG.maxDiscoveries),
          discoveryChars: numberOf(node.settings, 'discoveryChars', DEFAULT_COMPACTION_CONFIG.discoveryChars),
        }),
      },
    };
  }),
};

export function cappedText(written: string, maxChars: number, keep: 'start' | 'end'): string {
  if (written.length <= maxChars) return written;
  const cut = written.length - maxChars;

  return keep === 'end'
    ? `…[${cut} characters truncated from the start]\n${written.slice(-maxChars)}`
    : `${written.slice(0, maxChars)}\n…[${cut} characters truncated from the end]`;
}

export const truncateText: BuiltInNode = {
  definition: defineNode({
    kind: 'truncate-text',
    title: 'Truncate Text',
    category: 'context',
    describe: 'Caps a piece of text at a number of characters and says how much was cut, so one long thing cannot crowd everything else out of the prompt.',
    role: 'value',
    inputs: [{ name: 'text', type: 'text', describe: 'The text to cap.', required: true }],
    outputs: [{ name: 'text', type: 'text', describe: 'The text, capped, with a note saying how much was cut when any was.' }],
    exits: [],
    settings: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', title: 'Characters kept', minimum: 100, maximum: 200_000, default: 4000 },
        keep: {
          type: 'string',
          title: 'Keep',
          describe: '"start" keeps the beginning, where something usually says what it is; "end" keeps the last of it, where an error or a total usually is.',
          enum: ['start', 'end'],
          default: 'start',
        },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `keeps the ${textOf(settings, 'keep', 'start')} ${numberOf(settings, 'maxChars', 4000)} characters`,
  }),
  implementation: valueImplementation('truncate-text', ({ node, inputs }) => ({
    outputs: {
      text: cappedText(
        (inputs.text as string | undefined) ?? '',
        numberOf(node.settings, 'maxChars', 4000),
        textOf(node.settings, 'keep', 'start') === 'end' ? 'end' : 'start',
      ),
    },
  })),
};

export const CONTEXT_NODES = [
  resolveTools,
  withdrawTools,
  describeEnvironmentNode,
  describeProcedure,
  describeTools,
  describeOutputsNode,
  warnRunningOut,
  text,
  buildContext,
  conversation,
  trimToolResults,
  handOffConversation,
  truncateText,
];
