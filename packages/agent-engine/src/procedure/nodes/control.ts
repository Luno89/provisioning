import { compileExpr, ExprError, referencedPaths } from '../expr.js';

export const BUILT_IN_REDUCERS = ['all', 'ok', 'first-ok', 'failed'] as const;

export type BuiltInReducer = (typeof BUILT_IN_REDUCERS)[number];
import type { RunOutcome } from '../../runtime/events.js';
import { defineNode } from '../definition.js';
import { stepImplementation, type BuiltInNode } from '../implementation.js';
import type { ChildOutcomeValue } from '../values.js';
import { numberOf, textOf } from './read.js';
import { templateProblems } from './tools.js';

export const CONDITION_ROOTS = ['value', 'counters', 'inputs'] as const;

export const condition: BuiltInNode = {
  definition: defineNode({
    kind: 'condition',
    title: 'Condition',
    category: 'control',
    describe: 'Checks an expression and leaves through true or false. The expression can read the wired value as "value", the run\'s counters as "counters" (rounds, toolCalls, totalTokens…) and its inputs as "inputs". Functions: len, empty, contains, startsWith, endsWith, matches.',
    role: 'step',
    inputs: [{ name: 'value', type: 'any', describe: 'What the expression reads as "value".' }],
    outputs: [],
    exits: [
      { name: 'true', describe: 'The expression held.' },
      { name: 'false', describe: 'It did not.' },
    ],
    settings: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: { type: 'string', title: 'Expression', minLength: 1, describe: 'For example: not empty(value) and counters.rounds < 5' },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => textOf(settings, 'expression') || 'checks nothing yet',
    check: (settings) => {
      const expression = textOf(settings, 'expression');
      if (!expression) return [];
      try {
        compileExpr(expression);
      } catch (err) {
        return [`its expression does not parse: ${err instanceof ExprError ? err.message : String(err)}`];
      }
      const unknown = referencedPaths(expression)
        .map((path) => path.split('.')[0]!)
        .filter((root) => !(CONDITION_ROOTS as readonly string[]).includes(root));
      return unknown.length > 0
        ? [`its expression reads ${[...new Set(unknown)].map((root) => `"${root}"`).join(', ')}, but it can only read ${CONDITION_ROOTS.join(', ')}`]
        : [];
    },
  }),
  implementation: stepImplementation('condition', ({ node, inputs, run }) => ({
    exit: compileExpr(textOf(node.settings, 'expression')).evaluate({
      value: inputs.value,
      counters: run.counters,
      inputs: run.inputs,
    }) ? 'true' : 'false',
  })),
};

const REDUCERS: Record<BuiltInReducer, (children: readonly ChildOutcomeValue[]) => ChildOutcomeValue[]> = {
  all: (children) => [...children],
  ok: (children) => children.filter((child) => child.outcome === 'ok'),
  'first-ok': (children) => children.filter((child) => child.outcome === 'ok').slice(0, 1),
  failed: (children) => children.filter((child) => child.outcome !== 'ok'),
};

export const merge: BuiltInNode = {
  definition: defineNode({
    kind: 'merge',
    title: 'Merge',
    category: 'control',
    describe: 'Reduces the outcomes of delegated work to the ones you want: all of them, only the ones that succeeded, the first that succeeded, or only the failures.',
    role: 'step',
    inputs: [{ name: 'children', type: 'json', describe: 'The outcomes to reduce.', required: true }],
    outputs: [{ name: 'merged', type: 'json', describe: 'The outcomes kept.' }],
    exits: [{ name: 'done', describe: 'Always.' }],
    settings: {
      type: 'object',
      properties: { strategy: { type: 'string', title: 'Keep', enum: BUILT_IN_REDUCERS, default: 'all' } },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `keeps ${textOf(settings, 'strategy', 'all')}`,
  }),
  implementation: stepImplementation('merge', ({ node, inputs }) => ({
    exit: 'done',
    outputs: {
      merged: REDUCERS[textOf(node.settings, 'strategy', 'all') as BuiltInReducer](inputs.children as ChildOutcomeValue[]),
    },
  })),
};

export const collect: BuiltInNode = {
  definition: defineNode({
    kind: 'collect',
    title: 'Collect',
    category: 'control',
    describe: 'Adds the wired value to a list each time it runs, so a loop can gather every result instead of only the last.',
    role: 'step',
    inputs: [{ name: 'item', type: 'any', describe: 'What to add this time.', required: true }],
    outputs: [{ name: 'items', type: 'json', describe: 'Everything collected so far, oldest first.' }],
    exits: [{ name: 'done', describe: 'Always.' }],
    settings: {
      type: 'object',
      properties: {
        spread: {
          type: 'boolean',
          title: 'Add a list\'s contents',
          describe: 'When the value is a list, add each thing in it rather than the list itself.',
          default: false,
        },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => (settings.spread === true ? 'collects everything in each list' : 'collects a list'),
  }),
  implementation: stepImplementation('collect', ({ node, inputs, previous }) => {
    const adding = node.settings.spread === true && Array.isArray(inputs.item) ? inputs.item : [inputs.item];
    return {
      exit: 'done',
      outputs: { items: [...((previous?.items as unknown[] | undefined) ?? []), ...adding] },
    };
  }),
};

export const FINISH_OUTCOMES = ['ok', 'failed', 'refused'] as const;

export const finish: BuiltInNode = {
  definition: defineNode({
    kind: 'finish',
    title: 'Finish',
    category: 'control',
    describe: 'Ends the run with an outcome and a reason. A wired reason replaces the written one, so a check that tripped can say what it saw.',
    role: 'step',
    inputs: [
      { name: 'reason', type: 'text', describe: 'Why the run ended. Replaces the written reason when wired.' },
      { name: 'result', type: 'any', describe: 'What the run hands back.' },
    ],
    outputs: [{ name: 'result', type: 'any', describe: 'What the run hands back.' }],
    exits: [],
    settings: {
      type: 'object',
      required: ['outcome'],
      properties: {
        outcome: { type: 'string', title: 'Outcome', enum: FINISH_OUTCOMES, default: 'ok' },
        reason: { type: 'string', title: 'Reason' },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => {
      const reason = textOf(settings, 'reason');
      return `finishes ${textOf(settings, 'outcome', 'ok')}${reason ? `: ${reason}` : ''}`;
    },
  }),
  implementation: stepImplementation('finish', ({ node, inputs }) => {
    const reason = typeof inputs.reason === 'string' && inputs.reason.trim() ? inputs.reason : textOf(node.settings, 'reason');
    return {
      finish: { outcome: textOf(node.settings, 'outcome', 'ok') as RunOutcome, ...(reason ? { reason } : {}) },
      ...(inputs.result !== undefined ? { outputs: { result: inputs.result } } : {}),
    };
  }),
};

const INPUTS_HELP = 'Inputs are JSON. {{values.name}} is replaced with that part of the wired values, and {{text}} with the wired text.';

const agentCheck = (settings: Readonly<Record<string, unknown>>, known: { agents?: ReadonlySet<string> | undefined }): string[] => {
  const agent = textOf(settings, 'agent');
  return agent && known.agents && !known.agents.has(agent) ? [`delegates to "${agent}", which is not a persona`] : [];
};

export const delegate: BuiltInNode = {
  definition: defineNode({
    kind: 'delegate',
    title: 'Delegate',
    category: 'control',
    describe: `Starts another persona as a child run with the inputs you write, waits for it to finish, and leaves by how it ended. The child gets nothing except those inputs, unless you wire it an environment — then it works in that same workspace instead of one of its own, so it can see what was done there. ${INPUTS_HELP}`,
    role: 'step',
    inputs: [
      { name: 'values', type: 'json', describe: 'Values the inputs can refer to as {{values.…}}.' },
      { name: 'text', type: 'text', describe: 'Text the inputs can refer to as {{text}}.' },
      { name: 'environment', type: 'environment', describe: 'A workspace to hand the child, so it works where the work was done rather than somewhere of its own. Nothing wired means it gets its own.' },
    ],
    outputs: [
      { name: 'outputs', type: 'json', describe: 'What the child run handed back.' },
      { name: 'text', type: 'text', describe: 'What the child handed back, as text: its result when that is text, otherwise the whole thing as JSON.' },
      { name: 'reason', type: 'text', describe: 'Why the child did not finish, when it did not.' },
    ],
    exits: [
      { name: 'ok', describe: 'The child finished ok.' },
      { name: 'failed', describe: 'The child failed, ran out of budget or was stopped.' },
    ],
    settings: {
      type: 'object',
      required: ['agent'],
      properties: {
        agent: { type: 'string', title: 'Persona', minLength: 1 },
        inputs: { type: 'string', title: 'Inputs', describe: INPUTS_HELP, multiline: true, default: '{}' },
        handles: {
          type: 'boolean',
          title: 'The procedure\'s job',
          describe: 'This step hands the work over itself, so the model is not offered this persona and is told the procedure does it.',
          default: false,
        },
        says: {
          type: 'string',
          title: 'What the model is told',
          describe: 'One line explaining what this step does for it, such as "A judge weighs your work when you finish." Used when this step is the procedure\'s job.',
          default: '',
        },
      },
    },
    runs: 'orchestration',
    spends: ['childRuns'],
    idempotent: false,
    summarize: (settings) =>
      `hands the work to ${textOf(settings, 'agent') || 'another persona'}${settings.handles === true ? ', which the model is not offered' : ''}`,
    check: (settings, known) => [
      ...agentCheck(settings, known),
      ...templateProblems(settings, 'inputs', 'its inputs'),
      ...(settings.handles === true && !textOf(settings, 'says')
        ? ['is the procedure\'s job but does not say what the model is told instead']
        : []),
    ],
  }),
};

export const fanOut: BuiltInNode = {
  definition: defineNode({
    kind: 'fan-out',
    title: 'Fan Out',
    category: 'control',
    describe: 'Starts one child run of a persona per item in a list, a few at a time, and waits for all of them. Each child gets { item, index }. Every outcome is handed on, successes and failures alike — use Merge to keep the ones you want.',
    role: 'step',
    inputs: [{ name: 'items', type: 'json', describe: 'The list to fan out over.', required: true }],
    outputs: [{ name: 'children', type: 'json', describe: 'Every child\'s outcome, in list order.' }],
    exits: [{ name: 'done', describe: 'Every child has finished.' }],
    settings: {
      type: 'object',
      required: ['agent'],
      properties: {
        agent: { type: 'string', title: 'Persona', minLength: 1 },
        maxParallel: { type: 'integer', title: 'At a time', minimum: 1, maximum: 50, default: 3 },
      },
    },
    runs: 'orchestration',
    spends: ['childRuns'],
    idempotent: false,
    summarize: (settings) => `runs ${textOf(settings, 'agent') || 'a persona'} for each item, ${numberOf(settings, 'maxParallel', 3)} at a time`,
    check: agentCheck,
  }),
};

export const waitForPerson: BuiltInNode = {
  definition: defineNode({
    kind: 'wait-for-person',
    title: 'Wait for Person',
    category: 'control',
    describe: 'Shows a person a message and pauses the run until they answer or the time runs out.',
    role: 'step',
    inputs: [{ name: 'details', type: 'text', describe: 'Shown under the message — for example the plan the person is asked to review.' }],
    outputs: [
      { name: 'answer', type: 'any', describe: 'What the person answered.' },
      { name: 'reason', type: 'text', describe: 'Why there was no answer, when there was none.' },
    ],
    exits: [
      { name: 'answered', describe: 'The person answered.' },
      { name: 'unanswered', describe: 'Nobody answered in time, or the run was cancelled.' },
    ],
    settings: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', title: 'Message', minLength: 1, multiline: true },
        timeoutMinutes: { type: 'integer', title: 'Wait for (minutes)', minimum: 1, default: 10_080 },
      },
    },
    runs: 'orchestration',
    idempotent: true,
    summarize: (settings) => {
      const prompt = textOf(settings, 'prompt');
      return prompt ? `asks: ${prompt.length > 50 ? `${prompt.slice(0, 50)}…` : prompt}` : 'asks a person';
    },
  }),
};

export const CONTROL_NODES = [condition, merge, collect, finish, delegate, fanOut, waitForPerson];
