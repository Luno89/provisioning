import { defineNode } from '../definition.js';
import type { BuiltInNode } from '../implementation.js';
import { textOf } from './read.js';

const TEMPLATE_HELP = 'Arguments are JSON. {{values.name}} is replaced with that part of the wired values, and {{text}} with the wired text.';

export function templateProblems(settings: Readonly<Record<string, unknown>>, name: string, what: string): string[] {
  try {
    const parsed: unknown = JSON.parse(textOf(settings, name, '{}'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? [] : [`${what} have to be a JSON object`];
  } catch (err) {
    return [`${what} are not valid JSON: ${(err as Error).message}`];
  }
}

export const APPROVAL_POLICIES = ['on-a-machine', 'always', 'never'] as const;

export const approveToolCalls: BuiltInNode = {
  definition: defineNode({
    kind: 'approve-tool-calls',
    title: 'Approve Tool Calls',
    category: 'tools',
    describe: 'Asks a person to allow each tool call before it runs. By default it only asks when the run is working on someone\'s own machine; sandboxes and the platform go straight through. A refused call gets a result saying so, which goes back to the model.',
    role: 'step',
    inputs: [
      { name: 'reply', type: 'reply', describe: 'The reply whose tool calls need approving.', required: true },
      { name: 'environment', type: 'environment', describe: 'Where the calls would run.' },
    ],
    outputs: [
      { name: 'approved', type: 'reply', describe: 'The reply with only the approved calls left in it.' },
      { name: 'refused', type: 'toolResults', describe: 'A result for each refused call.' },
    ],
    exits: [
      { name: 'approved', describe: 'At least one call may run.' },
      { name: 'refused', describe: 'Every call was refused.' },
    ],
    settings: {
      type: 'object',
      properties: {
        ask: {
          type: 'string',
          title: 'Ask',
          describe: '"on-a-machine" asks only for a registered machine, "always" asks for every call, "never" lets everything through.',
          enum: APPROVAL_POLICIES,
          default: 'on-a-machine',
        },
      },
    },
    runs: 'orchestration',
    idempotent: true,
    summarize: (settings) => {
      const ask = textOf(settings, 'ask', 'on-a-machine');
      if (ask === 'always') return 'asks before every tool call';
      if (ask === 'never') return 'lets every tool call through';
      return 'asks before a tool call on someone\'s machine';
    },
  }),
};

export const runToolCalls: BuiltInNode = {
  definition: defineNode({
    kind: 'run-tool-calls',
    title: 'Run Tool Calls',
    category: 'tools',
    describe: 'Runs every tool call in the reply, in order. A call naming a persona this one may delegate to starts that persona as a child run; every other call runs wherever its tool lives — the sandbox, a registered machine, or the platform. Each result is tagged with its call and the reply it answers.',
    role: 'step',
    inputs: [
      { name: 'reply', type: 'reply', describe: 'The reply whose tool calls to run.', required: true },
      { name: 'persona', type: 'persona', describe: 'Whose grants and delegates decide what may run.', required: true },
      { name: 'environment', type: 'environment', describe: 'Where environment tools run. Nothing wired means no environment.' },
    ],
    outputs: [{ name: 'results', type: 'toolResults', describe: 'One result per call, in the order they were asked for.' }],
    exits: [{ name: 'done', describe: 'Every call has a result, whether it succeeded or not.' }],
    settings: {
      type: 'object',
      properties: {
        digestChars: {
          type: 'integer',
          title: 'Digest length',
          describe: 'How much of each result is kept as its short digest for traces and monitors.',
          minimum: 100,
          default: 2000,
        },
      },
    },
    runs: 'orchestration',
    spends: ['toolCalls', 'childRuns'],
    idempotent: false,
    summarize: () => 'runs the tools the model asked for',
  }),
};

export const callTool: BuiltInNode = {
  definition: defineNode({
    kind: 'call-tool',
    title: 'Call Tool',
    category: 'tools',
    describe: `Runs one named tool with arguments you write, without asking the model. ${TEMPLATE_HELP}`,
    role: 'step',
    inputs: [
      { name: 'values', type: 'json', describe: 'Values the arguments can refer to as {{values.…}}.' },
      { name: 'text', type: 'text', describe: 'Text the arguments can refer to as {{text}}.' },
      { name: 'persona', type: 'persona', describe: 'Whose grants decide whether the tool may run.', required: true },
      { name: 'environment', type: 'environment', describe: 'Where an environment tool runs.' },
    ],
    outputs: [
      { name: 'result', type: 'json', describe: 'What the tool returned, parsed as JSON when it is JSON.' },
      { name: 'text', type: 'text', describe: 'What the tool returned, as text.' },
    ],
    exits: [
      { name: 'ok', describe: 'The tool succeeded.' },
      { name: 'failed', describe: 'The tool failed or was refused.' },
    ],
    settings: {
      type: 'object',
      required: ['tool'],
      properties: {
        tool: { type: 'string', title: 'Tool', minLength: 1 },
        args: { type: 'string', title: 'Arguments', describe: TEMPLATE_HELP, multiline: true, default: '{}' },
      },
    },
    runs: 'orchestration',
    spends: ['toolCalls'],
    idempotent: false,
    summarize: (settings) => `calls ${textOf(settings, 'tool') || 'a tool'}`,
    check: (settings, known) => {
      const tool = textOf(settings, 'tool');
      return [
        ...(tool && known.tools && !known.tools.has(tool) ? [`calls "${tool}", which is not a tool`] : []),
        ...templateProblems(settings, 'args', 'its arguments'),
      ];
    },
  }),
};

export const TOOL_NODES = [approveToolCalls, runToolCalls, callTool];
