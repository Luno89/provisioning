import { detectThoughtLoop, type Turn } from '../../lib/thought-loop.js';
import { defineNode } from '../definition.js';
import { stepImplementation, type BuiltInNode } from '../implementation.js';
import type { ModelReply, ToolResult } from '../values.js';
import { numberOf } from './read.js';

const EXITS = [
  { name: 'ok', describe: 'Nothing wrong yet.' },
  { name: 'tripped', describe: 'The check tripped; "reason" says what it saw.' },
];

const REASON = { name: 'reason', type: 'text' as const, describe: 'What the check saw when it tripped.' };

export const checkRepetition: BuiltInNode = {
  definition: defineNode({
    kind: 'check-repetition',
    title: 'Check Repetition',
    category: 'safety',
    describe: 'Trips when the model keeps thinking and doing nearly the same thing turn after turn.',
    role: 'step',
    inputs: [{ name: 'reply', type: 'reply', describe: 'The latest reply.', required: true }],
    outputs: [REASON],
    exits: EXITS,
    settings: {
      type: 'object',
      properties: {
        minRounds: { type: 'integer', title: 'Watch from round', describe: 'Do not judge before this many turns.', minimum: 2, default: 4 },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `stops a model going in circles, from round ${numberOf(settings, 'minRounds', 4)}`,
  }),
  implementation: stepImplementation('check-repetition', ({ node, inputs, previous }) => {
    const reply = inputs.reply as ModelReply;
    const seen = (previous?.replies as string[] | undefined) ?? [];
    const earlier = (previous?.turns as Turn[] | undefined) ?? [];

    if (seen.includes(reply.id)) return { exit: 'ok', outputs: { ...previous } };

    const turns = [
      ...earlier,
      {
        thought: reply.thinking,
        action: reply.toolCalls.map((call) => `${call.name}:${call.arguments}`).join(' ') || reply.content,
      },
    ];
    const state = { turns, replies: [...seen, reply.id] };

    if (turns.length < numberOf(node.settings, 'minRounds', 4)) return { exit: 'ok', outputs: state };

    const verdict = detectThoughtLoop(turns);
    return verdict.looping
      ? { exit: 'tripped', outputs: { ...state, reason: verdict.reason || 'going in circles' } }
      : { exit: 'ok', outputs: state };
  }),
};

export const checkStall: BuiltInNode = {
  definition: defineNode({
    kind: 'check-stall',
    title: 'Check Stall',
    category: 'safety',
    describe: 'Trips when the model has neither said anything nor asked for a tool for several replies in a row.',
    role: 'step',
    inputs: [{ name: 'reply', type: 'reply', describe: 'The latest reply.', required: true }],
    outputs: [REASON],
    exits: EXITS,
    settings: {
      type: 'object',
      properties: { maxSilentRounds: { type: 'integer', title: 'Silent replies allowed', minimum: 1, default: 2 } },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `stops after ${numberOf(settings, 'maxSilentRounds', 2)} empty replies in a row`,
  }),
  implementation: stepImplementation('check-stall', ({ node, inputs, previous }) => {
    const reply = inputs.reply as ModelReply;
    const seen = (previous?.replies as string[] | undefined) ?? [];
    if (seen.includes(reply.id)) return { exit: 'ok', outputs: { ...previous } };

    const silent = reply.content.trim().length === 0 && reply.toolCalls.length === 0;
    const silentRounds = silent ? ((previous?.silentRounds as number | undefined) ?? 0) + 1 : 0;
    const state = { silentRounds, replies: [...seen, reply.id] };
    const limit = numberOf(node.settings, 'maxSilentRounds', 2);

    return silentRounds >= limit
      ? { exit: 'tripped', outputs: { ...state, reason: `produced nothing for ${silentRounds} rounds in a row` } }
      : { exit: 'ok', outputs: state };
  }),
};

export const checkToolFailures: BuiltInNode = {
  definition: defineNode({
    kind: 'check-tool-failures',
    title: 'Check Tool Failures',
    category: 'safety',
    describe: 'Trips when tool calls keep failing one after another, across replies.',
    role: 'step',
    inputs: [{ name: 'results', type: 'toolResults', describe: 'The latest tool results.', required: true }],
    outputs: [REASON],
    exits: EXITS,
    settings: {
      type: 'object',
      properties: { maxConsecutiveFailures: { type: 'integer', title: 'Failures in a row allowed', minimum: 1, default: 3 } },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `stops after ${numberOf(settings, 'maxConsecutiveFailures', 3)} failed tool calls in a row`,
  }),
  implementation: stepImplementation('check-tool-failures', ({ node, inputs, previous }) => {
    const results = inputs.results as ToolResult[];
    const counted = (previous?.counted as string[] | undefined) ?? [];
    const batch = results[0]?.forReply;
    if (batch !== undefined && counted.includes(batch)) return { exit: 'ok', outputs: { ...previous } };

    let consecutive = (previous?.consecutive as number | undefined) ?? 0;
    for (const result of results) consecutive = result.ok ? 0 : consecutive + 1;

    const state = { consecutive, counted: batch === undefined ? counted : [...counted, batch] };
    const limit = numberOf(node.settings, 'maxConsecutiveFailures', 3);

    return consecutive >= limit
      ? { exit: 'tripped', outputs: { ...state, reason: `${consecutive} tool calls failed in a row` } }
      : { exit: 'ok', outputs: state };
  }),
};

export const SAFETY_NODES = [checkRepetition, checkStall, checkToolFailures];
