import type { BudgetConfig } from '@koala/harness-types';
import { contextPressure, fittedMaxTokens } from '../../model/sampling.js';
import { defineNode } from '../definition.js';
import { valueImplementation, type BuiltInNode } from '../implementation.js';
import { promptCharacters, type ChatMessage, type ModelBinding } from '../values.js';
import { numberOf, textOf } from './read.js';

export const DEFAULT_CONTEXT_MARGIN = 1000;
export const DEFAULT_MIN_REPLY_TOKENS = 512;

export const chooseModel: BuiltInNode = {
  definition: defineNode({
    kind: 'choose-model',
    title: 'Choose Model',
    category: 'model',
    describe: 'Picks the endpoint and model to call, the sampling to call it with, and the most a reply may ever use. No API key travels on the wire; Call Model looks it up when it calls.',
    role: 'value',
    inputs: [{ name: 'persona', type: 'persona', describe: 'The persona whose model and sampling apply unless overridden.', required: true }],
    outputs: [{ name: 'binding', type: 'modelBinding', describe: 'Which model to call and how.' }],
    exits: [],
    settings: {
      type: 'object',
      properties: {
        modelId: {
          type: 'string',
          title: 'Model',
          describe: 'Leave empty to use the model the run was started with, then the persona\'s, then the account default.',
        },
        replyCeiling: {
          type: 'integer',
          title: 'Reply ceiling',
          describe: 'The most tokens a reply may use. Leave it empty to let the model use whatever the context window has room for until its track record says what it typically needs.',
          minimum: 256,
          maximum: 200_000,
        },
        temperature: {
          type: 'number',
          title: 'Temperature',
          describe: 'Leave empty to use the persona\'s sampling.',
          minimum: 0,
          maximum: 2,
        },
      },
    },
    runs: 'activity',
    idempotent: true,
    summarize: (settings) => {
      const model = textOf(settings, 'modelId');
      const temperature = settings.temperature;
      return [
        model ? `calls ${model}` : 'calls the run\'s model',
        typeof temperature === 'number' ? `at temperature ${temperature}` : '',
      ].filter(Boolean).join(' ');
    },
  }),
};

export const fitReplyBudget: BuiltInNode = {
  definition: defineNode({
    kind: 'fit-reply-budget',
    title: 'Fit Reply Budget',
    category: 'model',
    describe: 'Works out how many tokens the reply may use from what is left of the context window once the real prompt is in it, and how full the window is.',
    role: 'value',
    inputs: [
      { name: 'binding', type: 'modelBinding', describe: 'The model, for its context window and reply ceiling.', required: true },
      { name: 'system', type: 'text', describe: 'The system prompt that will be sent.', required: true },
      { name: 'messages', type: 'messages', describe: 'The conversation that will be sent.' },
    ],
    outputs: [
      { name: 'maxTokens', type: 'json', describe: 'The reply cap to call the model with.' },
      { name: 'pressure', type: 'json', describe: 'How full the context window is, from 0 to 1.' },
    ],
    exits: [],
    settings: {
      type: 'object',
      properties: {
        marginTokens: {
          type: 'integer',
          title: 'Safety margin',
          describe: 'Tokens kept free on top of the prompt, because the character count only estimates tokens.',
          minimum: 0,
          default: DEFAULT_CONTEXT_MARGIN,
        },
        minReplyTokens: {
          type: 'integer',
          title: 'Smallest reply',
          describe: 'Never cap a reply below this, even when the window is nearly full.',
          minimum: 1,
          default: DEFAULT_MIN_REPLY_TOKENS,
        },
      },
    },
    runs: 'workflow',
    idempotent: true,
    summarize: (settings) => `keeps ${numberOf(settings, 'marginTokens', DEFAULT_CONTEXT_MARGIN)} tokens spare`,
  }),
  implementation: valueImplementation('fit-reply-budget', ({ node, inputs }) => {
    const binding = inputs.binding as ModelBinding;
    const budget = {
      contextTokens: binding.contextTokens,
      contextMargin: numberOf(node.settings, 'marginTokens', DEFAULT_CONTEXT_MARGIN),
      minReplyTokens: numberOf(node.settings, 'minReplyTokens', DEFAULT_MIN_REPLY_TOKENS),
    } as BudgetConfig;
    const chars = promptCharacters(inputs.system as string, (inputs.messages as ChatMessage[] | undefined) ?? []);

    return {
      outputs: {
        maxTokens: fittedMaxTokens(budget, binding.replyCeiling ?? Number.MAX_SAFE_INTEGER, chars, binding.contextTokens),
        pressure: contextPressure(budget, chars, binding.contextTokens),
      },
    };
  }),
};

export const callModel: BuiltInNode = {
  definition: defineNode({
    kind: 'call-model',
    title: 'Call Model',
    category: 'model',
    describe: 'Sends the system prompt, the conversation and the offered tools to the model, streams the reply, and leaves by what the reply turned out to be.',
    role: 'step',
    inputs: [
      { name: 'binding', type: 'modelBinding', describe: 'Which model to call and how.', required: true },
      { name: 'system', type: 'text', describe: 'The system prompt.', required: true },
      { name: 'messages', type: 'messages', describe: 'The conversation so far.', required: true },
      { name: 'tools', type: 'toolSet', describe: 'The tools to offer. Nothing wired means none.' },
      { name: 'maxTokens', type: 'json', describe: 'The reply cap. Nothing wired means the binding\'s ceiling.' },
    ],
    outputs: [
      { name: 'reply', type: 'reply', describe: 'The whole reply: content, thinking, tool calls and why it stopped.' },
      { name: 'toolCalls', type: 'toolCalls', describe: 'Just the tool calls it asked for.' },
      { name: 'content', type: 'text', describe: 'Just what it said.' },
    ],
    exits: [
      { name: 'toolCalls', describe: 'It asked for one or more tools.' },
      { name: 'answered', describe: 'It replied without asking for tools.' },
      { name: 'truncated', describe: 'It ran out of reply tokens mid-reply.' },
      { name: 'empty', describe: 'It stopped without saying or asking for anything.' },
    ],
    settings: {
      type: 'object',
      properties: {
        toolChoice: {
          type: 'string',
          title: 'Tool choice',
          describe: '"none" sends the tools for reference but tells the model not to call any.',
          enum: ['auto', 'none'],
          default: 'auto',
        },
        reasoningEffort: {
          type: 'string',
          title: 'Reasoning effort',
          describe: 'For models that support it. Leave empty for the model\'s default.',
          enum: ['low', 'medium', 'high'],
        },
        stopOverthinking: {
          type: 'boolean',
          title: 'Stop overthinking',
          describe: 'Cut the stream off when its thinking starts going in circles. This has to happen mid-stream, which is why it is a setting rather than a node after the call.',
          default: true,
        },
      },
    },
    runs: 'stream',
    spends: ['rounds', 'tokens'],
    idempotent: true,
    summarize: (settings) => (textOf(settings, 'toolChoice', 'auto') === 'none' ? 'asks the model, allowing no tool calls' : 'asks the model'),
  }),
};

export const DECISIONS = ['yes', 'no', 'unsure'] as const;

export type Decision = (typeof DECISIONS)[number];

export const DECIDE_INSTRUCTIONS = 'You answer one yes-or-no question about the text you are given. '
  + 'Start your reply with a line that is exactly yes, no or unsure. After it, say in one or two sentences why.';

export function readDecision(content: string): Decision {
  const first = content.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  const word = first.toLowerCase().replace(/^[^a-z]+/, '').split(/[^a-z]/)[0] ?? '';
  return (DECISIONS as readonly string[]).includes(word) ? (word as Decision) : 'unsure';
}

export const decide: BuiltInNode = {
  definition: defineNode({
    kind: 'decide',
    title: 'Decide',
    category: 'model',
    describe: 'Asks a model a yes-or-no question about some text — for example whether a judge\'s verdict says the work passed — and leaves through yes, no or unsure.',
    role: 'step',
    inputs: [
      { name: 'binding', type: 'modelBinding', describe: 'Which model decides.', required: true },
      { name: 'text', type: 'any', describe: 'What the question is about. Anything that is not text is shown to the model as JSON.', required: true },
    ],
    outputs: [
      { name: 'decision', type: 'text', describe: 'yes, no or unsure.' },
      { name: 'why', type: 'text', describe: 'The model\'s whole answer, including why it decided that.' },
    ],
    exits: [
      { name: 'yes', describe: 'The model answered yes.' },
      { name: 'no', describe: 'The model answered no.' },
      { name: 'unsure', describe: 'The model was unsure, or did not answer with yes or no.' },
    ],
    settings: {
      type: 'object',
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          title: 'Question',
          describe: 'A question that can be answered yes or no from the text alone.',
          minLength: 1,
          multiline: true,
          default: 'Does this say the work meets what was asked?',
        },
      },
    },
    runs: 'stream',
    spends: ['rounds', 'tokens'],
    idempotent: true,
    summarize: (settings) => {
      const question = textOf(settings, 'question');
      return question ? `decides: ${question.length > 50 ? `${question.slice(0, 50)}…` : question}` : 'decides yes or no';
    },
  }),
};

export const MODEL_NODES = [chooseModel, fitReplyBudget, callModel, decide];
