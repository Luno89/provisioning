import { defineNode, type SocketSpec } from '../definition.js';
import type { GroupSetting } from '../settings-schema.js';
import type { BuiltInNode } from '../implementation.js';
import { SOCKET_TYPES, isSocketType, type SocketType } from '../sockets.js';
import { numberOf, textOf } from './read.js';

export const CODE_KIND = 'code';

export const RUN_CODE_KIND = 'run-code';

export const CODE_KINDS: readonly string[] = [CODE_KIND, RUN_CODE_KIND];

export const DEFAULT_CODE_TIMEOUT_MS = 30_000;

const NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

export interface DeclaredSocket {
  name: string;
  type: SocketType;
  describe?: string | undefined;
}

export function declaredSockets(settings: Readonly<Record<string, unknown>>, key: string): SocketSpec[] {
  const listed = Array.isArray(settings[key]) ? (settings[key] as unknown[]) : [];

  return listed.flatMap((entry): SocketSpec[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, type, describe } = entry as Partial<DeclaredSocket>;
    if (typeof name !== 'string' || !NAME.test(name)) return [];

    return [{
      name,
      type: isSocketType(type) ? type : 'json',
      describe: typeof describe === 'string' && describe.trim() ? describe : `The "${name}" ${key === 'inputs' ? 'value it is given' : 'value it hands back'}.`,
    }];
  });
}

export function codeProblems(settings: Readonly<Record<string, unknown>>, kind: string = CODE_KIND): string[] {
  const problems: string[] = [];
  if (!textOf(settings, 'body').trim()) problems.push('a code node needs a body to run');

  for (const key of ['inputs', 'outputs'] as const) {
    const listed = Array.isArray(settings[key]) ? (settings[key] as unknown[]) : [];
    const seen = new Set<string>();

    for (const entry of listed) {
      const { name, type } = (entry ?? {}) as Partial<DeclaredSocket>;
      if (typeof name !== 'string' || !NAME.test(name)) {
        problems.push(`"${String(name)}" is not a name a ${key === 'inputs' ? 'value it takes' : 'value it hands back'} can have`);
        continue;
      }
      if (seen.has(name)) problems.push(`it declares "${name}" twice under ${key}`);
      seen.add(name);
      if (type !== undefined && !isSocketType(type)) problems.push(`"${name}" is a "${String(type)}", which is not a kind of value`);
    }
  }

  if (declaredSockets(settings, 'inputs').some((socket) => socket.name === ENVIRONMENT.name)) {
    problems.push('"environment" is the workspace socket every code node already has, so it cannot be declared again');
  }
  if (kind === CODE_KIND && declaredSockets(settings, 'outputs').length === 0) problems.push('a code node has to hand something back, so it needs at least one output');
  if (kind === RUN_CODE_KIND && declaredSockets(settings, 'outputs').some((socket) => socket.name === RUN_CODE_ERROR.name)) {
    problems.push('"error" is where a failed run says what went wrong, so it cannot be declared as an output');
  }
  return problems;
}

const SOCKET_LIST = (title: string, describe: string) => ({
  type: 'array' as const,
  title,
  describe,
  default: [],
  items: {
    type: 'object' as const,
    title: 'Value',
    properties: {
      name: { type: 'string' as const, title: 'Name', minLength: 1 },
      type: { type: 'string' as const, title: 'Kind', enum: [...SOCKET_TYPES], default: 'json' },
      describe: { type: 'string' as const, title: 'What it is' },
    },
  },
});

const ENVIRONMENT: SocketSpec = {
  name: 'environment',
  type: 'environment',
  describe: 'The workspace to run the code in. Wire the sandbox the run provisioned.',
  required: true,
};

const CODE_SETTINGS: GroupSetting = {
  type: 'object',
  required: ['body'],
  properties: {
    body: {
      type: 'string',
      title: 'Body',
      describe: 'JavaScript. It is given "inputs" and returns an object with the values it declares. Top-level await works.',
      multiline: true,
      default: 'return { result: inputs }',
    },
    inputs: SOCKET_LIST('Values it takes', 'Each one becomes a socket you can wire into, and a key on "inputs".'),
    outputs: SOCKET_LIST('Values it hands back', 'Each one becomes a socket you can wire out of, and a key on what the body returns.'),
    timeoutMs: {
      type: 'integer',
      title: 'Give up after',
      describe: 'Milliseconds before the body is stopped.',
      minimum: 100,
      maximum: 600_000,
      default: DEFAULT_CODE_TIMEOUT_MS,
    },
  },
};

export const code: BuiltInNode = {
  definition: defineNode({
    kind: CODE_KIND,
    title: 'Code',
    category: 'context',
    describe: 'Runs a piece of JavaScript you wrote, in this run\'s own sandbox, with the values you wire in and the values you declare it hands back. The body is never read as a procedure — it is written out and executed there, so it can do anything the sandbox can, and nothing it cannot.',
    role: 'value',
    inputs: [],
    outputs: [],
    exits: [],
    settings: CODE_SETTINGS,
    runs: 'sandbox',
    idempotent: false,
    summarize: (settings) => {
      const outputs = declaredSockets(settings, 'outputs').map((socket) => socket.name);
      return outputs.length > 0 ? `runs your code for ${outputs.join(', ')}` : 'runs your code';
    },
    check: (settings) => codeProblems(settings),
    sockets: (settings) => ({
      inputs: [ENVIRONMENT, ...declaredSockets(settings, 'inputs')],
      outputs: declaredSockets(settings, 'outputs'),
    }),
  }),
};

export const codeTimeout = (settings: Readonly<Record<string, unknown>>): number =>
  numberOf(settings, 'timeoutMs', DEFAULT_CODE_TIMEOUT_MS);

const RUN_CODE_ERROR: SocketSpec = { name: 'error', type: 'text', describe: 'What went wrong, when the code threw or ran out of time.' };

export const runCode: BuiltInNode = {
  definition: defineNode({
    kind: RUN_CODE_KIND,
    title: 'Run Code',
    category: 'environment',
    describe: 'Runs a piece of JavaScript you wrote, once, at this point in the flow, in this run\'s own sandbox. Use it for code that changes something — writes a file, calls a service — or that is too slow to run again: unlike Code, which is worked out afresh by every step that reads it, this runs exactly when the flow reaches it, and what it hands back is kept.',
    role: 'step',
    inputs: [],
    outputs: [],
    exits: [
      { name: 'ok', describe: 'The code ran and handed back what it declares.' },
      { name: 'failed', describe: 'The code threw or ran out of time, and "error" says why.' },
    ],
    settings: CODE_SETTINGS,
    runs: 'sandbox',
    idempotent: false,
    summarize: (settings) => {
      const outputs = declaredSockets(settings, 'outputs').map((socket) => socket.name);
      return outputs.length > 0 ? `runs your code once for ${outputs.join(', ')}` : 'runs your code once';
    },
    check: (settings) => codeProblems(settings, RUN_CODE_KIND),
    sockets: (settings) => ({
      inputs: [ENVIRONMENT, ...declaredSockets(settings, 'inputs')],
      outputs: [...declaredSockets(settings, 'outputs'), RUN_CODE_ERROR],
    }),
  }),
};

export const CODE_NODES = [code, runCode];
