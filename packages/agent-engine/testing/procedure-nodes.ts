import {
  createNodeCatalogue,
  defineNode,
  NO_SETTINGS,
  PROCEDURE_SCHEMA,
  type Flow,
  type GroupDefinition,
  type NodeExecutor,
  type NodeRequest,
  type PlacedNode,
  type Procedure,
  type StepResult,
  type ValueResult,
  type Wire,
} from '../src/procedure/index.js';

export const noteNode = defineNode({
  kind: 'note',
  title: 'Note',
  category: 'context',
  describe: 'A fixed piece of text',
  role: 'value',
  inputs: [],
  outputs: [{ name: 'text', type: 'text', describe: 'The text' }],
  exits: [],
  settings: { type: 'object', properties: { text: { type: 'string', default: '' } } },
  runs: 'workflow',
  idempotent: true,
  summarize: (settings) => String(settings.text ?? ''),
});

export const joinNode = defineNode({
  kind: 'join-text',
  title: 'Join Text',
  category: 'context',
  describe: 'Joins several pieces of text in wire order',
  role: 'value',
  inputs: [{ name: 'parts', type: 'text', describe: 'The pieces, in order', many: true, required: true }],
  outputs: [{ name: 'text', type: 'text', describe: 'The joined text' }],
  exits: [],
  settings: { type: 'object', properties: { separator: { type: 'string', default: '\n' } } },
  runs: 'workflow',
  idempotent: true,
  summarize: () => 'joins text',
});

export const askNode = defineNode({
  kind: 'ask',
  title: 'Ask',
  category: 'model',
  describe: 'Answers a prompt yes or no',
  role: 'step',
  inputs: [{ name: 'prompt', type: 'text', describe: 'What to answer', required: true }],
  outputs: [{ name: 'reply', type: 'text', describe: 'The answer' }],
  exits: [
    { name: 'yes', describe: 'It said yes' },
    { name: 'no', describe: 'It said no' },
  ],
  settings: NO_SETTINGS,
  runs: 'stream',
  spends: ['rounds', 'tokens'],
  idempotent: false,
  summarize: () => 'asks',
});

export const echoNode = defineNode({
  kind: 'echo',
  title: 'Echo',
  category: 'control',
  describe: 'Passes text through',
  role: 'step',
  inputs: [{ name: 'text', type: 'text', describe: 'Text to pass on' }],
  outputs: [{ name: 'text', type: 'text', describe: 'The same text' }],
  exits: [{ name: 'done', describe: 'Always' }],
  settings: NO_SETTINGS,
  runs: 'workflow',
  idempotent: true,
  summarize: () => 'echoes',
});

export const watchNode = defineNode({
  kind: 'watch',
  title: 'Watch',
  category: 'safety',
  describe: 'Trips when the replies it is shown keep repeating',
  role: 'step',
  inputs: [{ name: 'text', type: 'text', describe: 'The latest reply' }],
  outputs: [],
  exits: [
    { name: 'ok', describe: 'Not repeating' },
    { name: 'tripped', describe: 'Repeating' },
  ],
  settings: NO_SETTINGS,
  runs: 'workflow',
  idempotent: true,
  summarize: () => 'watches',
});

export const countNode = defineNode({
  kind: 'count',
  title: 'Count',
  category: 'control',
  describe: 'Counts up from its own previous output until a limit',
  role: 'step',
  inputs: [{ name: 'previous', type: 'json', describe: 'The count so far' }],
  outputs: [{ name: 'count', type: 'json', describe: 'The new count' }],
  exits: [
    { name: 'again', describe: 'Below the limit' },
    { name: 'done', describe: 'Reached the limit' },
  ],
  settings: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, default: 3 } },
    required: ['limit'],
  },
  runs: 'workflow',
  idempotent: true,
  summarize: (settings) => `counts to ${String(settings.limit)}`,
});

export const callToolNode = defineNode({
  kind: 'call-tool',
  title: 'Call Tool',
  category: 'tools',
  describe: 'Calls one named tool',
  role: 'step',
  inputs: [],
  outputs: [{ name: 'result', type: 'json', describe: 'What the tool returned' }],
  exits: [{ name: 'done', describe: 'The tool returned' }],
  settings: {
    type: 'object',
    properties: { tool: { type: 'string', minLength: 1 } },
    required: ['tool'],
  },
  runs: 'activity',
  idempotent: false,
  summarize: (settings) => `calls ${String(settings.tool)}`,
  check: (settings, known) =>
    known.tools && typeof settings.tool === 'string' && !known.tools.has(settings.tool)
      ? [`calls "${settings.tool}", which is not a tool`]
      : [],
});

export const finishNode = defineNode({
  kind: 'finish',
  title: 'Finish',
  category: 'control',
  describe: 'Ends the run',
  role: 'step',
  inputs: [],
  outputs: [],
  exits: [],
  settings: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['ok', 'failed'], default: 'ok' },
      reason: { type: 'string' },
    },
    required: ['outcome'],
  },
  runs: 'workflow',
  idempotent: true,
  summarize: (settings) => `finishes ${String(settings.outcome)}`,
});

export const TEST_NODES = [watchNode, noteNode, joinNode, askNode, echoNode, countNode, callToolNode, finishNode];

export const testCatalogue = () => createNodeCatalogue(TEST_NODES);

export const node = (
  id: string,
  kind: string,
  settings: Record<string, unknown> = {},
  extra: Partial<PlacedNode> = {},
): PlacedNode => ({ id, kind, settings, position: { x: 0, y: 0 }, ...extra });

export const groupNode = (id: string, group: string): PlacedNode => node(id, 'group', {}, { group });

export const wire = (from: string, to: string): Wire => {
  const [fromNode, fromSocket] = from.split(':') as [string, string];
  const [toNode, toSocket] = to.split(':') as [string, string];
  return { from: { node: fromNode, socket: fromSocket }, to: { node: toNode, socket: toSocket } };
};

export const flow = (from: string, to: string): Flow => {
  const [fromNode, exit] = from.split(':') as [string, string];
  return { from: fromNode, exit, to };
};

export const procedure = (over: Partial<Procedure> & Pick<Procedure, 'start' | 'nodes'>): Procedure => ({
  schema: PROCEDURE_SCHEMA,
  id: 'test',
  version: '1',
  name: 'Test',
  describe: 'A procedure for tests',
  budget: {},
  wires: [],
  flow: [],
  groups: [],
  ...over,
});

export const group = (over: Partial<GroupDefinition> & Pick<GroupDefinition, 'id' | 'start' | 'nodes'>): GroupDefinition => ({
  title: over.id,
  describe: `the ${over.id} group`,
  wires: [],
  flow: [],
  inputs: [],
  outputs: [],
  exits: [],
  ...over,
});

export type StepHandler = (request: NodeRequest) => StepResult | Promise<StepResult>;
export type ValueHandler = (request: NodeRequest) => ValueResult | Promise<ValueResult>;

export interface ScriptedExecutor extends NodeExecutor {
  calls: { node: string; kind: string; inputs: Record<string, unknown>; cleaningUp: boolean }[];
}

export function scriptedExecutor(
  steps: Record<string, StepHandler> = {},
  values: Record<string, ValueHandler> = {},
): ScriptedExecutor {
  const calls: ScriptedExecutor['calls'] = [];
  const remember = (request: NodeRequest) =>
    calls.push({ node: request.node.id, kind: request.node.kind, inputs: request.inputs, cleaningUp: request.run.cleaningUp });

  const defaultValues: Record<string, ValueHandler> = {
    note: ({ node: placed }) => ({ outputs: { text: String(placed.settings.text ?? '') } }),
    'join-text': ({ node: placed, inputs }) => ({
      outputs: { text: (inputs.parts as string[]).join(String(placed.settings.separator ?? '\n')) },
    }),
  };

  const defaultSteps: Record<string, StepHandler> = {
    echo: ({ inputs }) => ({ exit: 'done', outputs: { text: inputs.text } }),
    count: ({ node: placed, inputs }) => {
      const count = (typeof inputs.previous === 'number' ? inputs.previous : 0) + 1;
      return { exit: count >= Number(placed.settings.limit) ? 'done' : 'again', outputs: { count } };
    },
    finish: ({ node: placed }) => ({
      finish: {
        outcome: placed.settings.outcome as 'ok' | 'failed',
        ...(typeof placed.settings.reason === 'string' ? { reason: placed.settings.reason } : {}),
      },
    }),
  };

  return {
    calls,
    async step(request) {
      remember(request);
      const handler = steps[request.node.id] ?? steps[request.node.kind] ?? defaultSteps[request.node.kind];
      if (!handler) throw new Error(`no scripted step for "${request.node.id}"`);
      return handler(request);
    },
    async value(request) {
      remember(request);
      const handler = values[request.node.id] ?? values[request.node.kind] ?? defaultValues[request.node.kind];
      if (!handler) throw new Error(`no scripted value for "${request.node.id}"`);
      return handler(request);
    },
  };
}
