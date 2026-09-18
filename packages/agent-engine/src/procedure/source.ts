import type { NodeCatalogue, NodeDefinition, SocketSpec } from './definition.js';
import { PROCEDURE_SCHEMA, type GroupDefinition, type PlacedNode, type Procedure } from './schema.js';
import type { SettingSchema } from './settings-schema.js';
import { checkProcedure, procedureErrors, type CheckOptions, type ProcedureProblem } from './validate.js';

export type ParsedProcedure =
  | { ok: true; procedure: Procedure; problems: ProcedureProblem[] }
  | { ok: false; problems: ProcedureProblem[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const refuse = (message: string): ParsedProcedure => ({ ok: false, problems: [{ severity: 'error', message }] });

const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function placed(value: unknown): PlacedNode {
  const node = isRecord(value) ? value : {};
  const position = isRecord(node.position) ? node.position : {};
  return {
    ...(node as unknown as PlacedNode),
    settings: isRecord(node.settings) ? node.settings : {},
    position: {
      x: typeof position.x === 'number' ? position.x : 0,
      y: typeof position.y === 'number' ? position.y : 0,
    },
  };
}

function groupOf(value: unknown): GroupDefinition {
  const group = isRecord(value) ? value : {};
  return {
    ...(group as unknown as GroupDefinition),
    nodes: listOf(group.nodes).map(placed),
    wires: listOf(group.wires),
    flow: listOf(group.flow),
    inputs: listOf(group.inputs),
    outputs: listOf(group.outputs),
    exits: listOf(group.exits),
  };
}

export function readProcedure(source: string | Record<string, unknown>): ParsedProcedure {
  let raw: unknown = source;
  if (typeof source === 'string') {
    try {
      raw = JSON.parse(source);
    } catch (err) {
      return refuse(`this is not valid JSON: ${(err as Error).message}`);
    }
  }

  if (!isRecord(raw)) return refuse('a procedure has to be a JSON object');
  if (raw.schema !== PROCEDURE_SCHEMA) {
    return refuse(`this is not a format ${PROCEDURE_SCHEMA} procedure — it needs "schema": ${PROCEDURE_SCHEMA}, and nodes joined by "wires" and "flow"`);
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) return refuse('a procedure needs an "id"');
  if (!Array.isArray(raw.nodes)) return refuse('a procedure needs a "nodes" list');
  if (typeof raw.start !== 'string') return refuse('a procedure needs a "start" naming the step it begins at');

  const procedure: Procedure = {
    schema: PROCEDURE_SCHEMA,
    id: raw.id.trim(),
    version: typeof raw.version === 'string' && raw.version.trim() ? raw.version : '1',
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : raw.id.trim(),
    describe: typeof raw.describe === 'string' ? raw.describe : '',
    budget: isRecord(raw.budget) ? raw.budget : {},
    start: raw.start,
    ...(typeof raw.cleanup === 'string' ? { cleanup: raw.cleanup } : {}),
    nodes: raw.nodes.map(placed),
    wires: listOf(raw.wires),
    flow: listOf(raw.flow),
    groups: listOf(raw.groups).map(groupOf),
  };

  return { ok: true, procedure, problems: [] };
}

export function readAndCheckProcedure(source: string | Record<string, unknown>, options: CheckOptions): ParsedProcedure {
  const read = readProcedure(source);
  if (!read.ok) return read;

  const problems = checkProcedure(read.procedure, options);
  return procedureErrors(problems).length > 0 ? { ok: false, problems } : { ok: true, procedure: read.procedure, problems };
}

export function formatProcedureProblems(problems: readonly ProcedureProblem[]): string {
  return problems
    .map((problem) => {
      const where = [
        problem.group ? `in group "${problem.group}"` : '',
        problem.node ? `node "${problem.node}"` : '',
        problem.socket ? `socket "${problem.socket}"` : '',
        problem.exit ? `exit "${problem.exit}"` : '',
      ].filter(Boolean).join(', ');
      return `- ${problem.severity === 'warning' ? 'warning: ' : ''}${where ? `${where}: ` : ''}${problem.message}`;
    })
    .join('\n');
}

const settingType = (schema: SettingSchema): string => {
  if (schema.type === 'string' && schema.enum) return schema.enum.map((option) => JSON.stringify(option)).join(' | ');
  if (schema.type === 'array') return `list of ${settingType(schema.items)}`;
  if (schema.type === 'object') return `{ ${Object.entries(schema.properties).map(([name, inner]) => `${name}: ${settingType(inner)}`).join(', ')} }`;
  return schema.type;
};

const socketLine = (socket: Pick<SocketSpec, 'name' | 'type' | 'required' | 'many'>): string =>
  `${socket.name}: ${socket.type}${socket.required ? ', required' : ''}${socket.many ? ', takes many wires' : ''}`;

function describeKind(definition: NodeDefinition): string {
  const lines = [`- ${definition.kind} (${definition.role}) — ${definition.describe}`];
  if (definition.inputs.length > 0) lines.push(`  inputs: ${definition.inputs.map(socketLine).join('; ')}`);
  if (definition.outputs.length > 0) lines.push(`  outputs: ${definition.outputs.map((socket) => `${socket.name}: ${socket.type}`).join('; ')}`);
  if (definition.exits.length > 0) lines.push(`  exits: ${definition.exits.map((exit) => exit.name).join(', ')}`);

  const required = new Set(definition.settings.required ?? []);
  const settings = Object.entries(definition.settings.properties).map(([name, schema]) =>
    `${name}${required.has(name) ? ' (required)' : ''}: ${settingType(schema)}${schema.default !== undefined ? ` = ${JSON.stringify(schema.default)}` : ''}`);
  if (settings.length > 0) lines.push(`  settings: ${settings.join('; ')}`);

  return lines.join('\n');
}

function describeGroup(group: GroupDefinition): string {
  return [
    `- "${group.id}" — ${group.describe}`,
    `  inputs: ${group.inputs.map(socketLine).join('; ') || 'none'}`,
    `  outputs: ${group.outputs.map((socket) => `${socket.name}: ${socket.type}`).join('; ') || 'none'}`,
    `  exits: ${group.exits.map((exit) => exit.name).join(', ') || 'none'}`,
  ].join('\n');
}

export const EXAMPLE_PROCEDURE: Record<string, unknown> = {
  schema: PROCEDURE_SCHEMA,
  id: 'quick-answer',
  version: '1',
  name: 'Quick answer',
  describe: 'Answers once, using tools until it has what it needs.',
  budget: {},
  start: 'history',
  nodes: [
    { id: 'input', kind: 'run-input' },
    { id: 'history', kind: 'conversation' },
    { id: 'turn', kind: 'group', group: 'model-turn' },
    { id: 'tools', kind: 'group', group: 'tool-loop' },
    { id: 'answered', kind: 'finish', settings: { outcome: 'ok' } },
    { id: 'stuck', kind: 'finish', settings: { outcome: 'failed' } },
  ],
  wires: [
    { from: { node: 'input', socket: 'message' }, to: { node: 'history', socket: 'opening' } },
    { from: { node: 'history', socket: 'messages' }, to: { node: 'turn', socket: 'messages' } },
    { from: { node: 'turn', socket: 'reply' }, to: { node: 'history', socket: 'replies' } },
    { from: { node: 'turn', socket: 'reply' }, to: { node: 'tools', socket: 'reply' } },
    { from: { node: 'turn', socket: 'persona' }, to: { node: 'tools', socket: 'persona' } },
    { from: { node: 'tools', socket: 'results' }, to: { node: 'history', socket: 'results' } },
    { from: { node: 'tools', socket: 'refused' }, to: { node: 'history', socket: 'results' } },
    { from: { node: 'tools', socket: 'reason' }, to: { node: 'stuck', socket: 'reason' } },
  ],
  flow: [
    { from: 'history', exit: 'done', to: 'turn' },
    { from: 'turn', exit: 'toolCalls', to: 'tools' },
    { from: 'turn', exit: 'answered', to: 'answered' },
    { from: 'turn', exit: 'truncated', to: 'answered' },
    { from: 'turn', exit: 'empty', to: 'stuck' },
    { from: 'tools', exit: 'done', to: 'history' },
    { from: 'tools', exit: 'refused', to: 'history' },
    { from: 'tools', exit: 'failing', to: 'stuck' },
  ],
};

export function describeProcedureFormat(catalogue: NodeCatalogue, groups: readonly GroupDefinition[]): string {
  return [
    'PROCEDURE FORMAT',
    '',
    'A procedure is a JSON object: { "schema": 2, "id", "version", "name", "describe", "budget", "start", "cleanup"?, "nodes", "wires", "flow" }.',
    '- A node is { "id", "kind", "settings"? }. Ids are plain words without dots.',
    '- A step runs in order and leaves through one of its exits. A value node has no exits: it is worked out whenever a step needs what it produces.',
    '- "wires" carry data: { "from": { "node", "socket" }, "to": { "node", "socket" } }. The types on both ends have to match (any matches everything). A required input needs a wire; an input that takes many wires reads them in wire order.',
    '- "flow" decides what runs next: { "from": step id, "exit": exit name, "to": step id }. Every exit of every step needs exactly one flow.',
    '- "start" is the first step. "cleanup", if given, is a step that runs after the procedure ends however it ends — use it to release a sandbox.',
    '- "budget" is usually {}: how long a run may go is learned from how long this model has needed before. Set maxRounds, maxToolCalls, maxTokens or maxWallClockMs only to cap it regardless. A loop that calls the model should include Check Repetition or Check Stall so going in circles ends the run.',
    '- A group is used as a node { "id", "kind": "group", "group": group id }, with the group\'s own inputs, outputs and exits.',
    '',
    'NODE KINDS',
    '',
    ...catalogue.list().map(describeKind),
    '',
    'GROUPS',
    '',
    ...groups.map(describeGroup),
    '',
    'EXAMPLE',
    '',
    JSON.stringify(EXAMPLE_PROCEDURE, null, 2),
  ].join('\n');
}
