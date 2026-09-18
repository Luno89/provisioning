import type { SocketType } from './sockets.js';
import { isSocketType } from './sockets.js';
import type { GroupSetting } from './settings-schema.js';
import { BUDGET_SPENDS, type BudgetSpend } from '../runtime/run.js';

export type NodeRole = 'step' | 'value';

export type NodePlacement = 'workflow' | 'orchestration' | 'activity' | 'stream' | 'sandbox';

export const NODE_CATEGORIES = [
  'input',
  'context',
  'model',
  'tools',
  'environment',
  'memory',
  'control',
  'safety',
  'custom',
] as const;

export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export interface SocketSpec {
  name: string;
  type: SocketType;
  describe: string;
  required?: boolean | undefined;
  many?: boolean | undefined;
}

export interface ExitSpec {
  name: string;
  describe: string;
}

export interface KnownReferences {
  tools?: ReadonlySet<string> | undefined;
  agents?: ReadonlySet<string> | undefined;
}

export interface NodeDefinition {
  kind: string;
  title: string;
  category: NodeCategory;
  describe: string;
  role: NodeRole;
  inputs: readonly SocketSpec[];
  outputs: readonly SocketSpec[];
  exits: readonly ExitSpec[];
  settings: GroupSetting;
  runs: NodePlacement;
  idempotent: boolean;
  spends?: readonly BudgetSpend[] | undefined;
  summarize(settings: Readonly<Record<string, unknown>>): string;
  check?(settings: Readonly<Record<string, unknown>>, known: KnownReferences): string[];
}

export const defineNode = (definition: NodeDefinition): NodeDefinition => definition;

export const GROUP_KIND = 'group';

const KIND_PATTERN = /^[a-z][a-z0-9-]*$/;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated];
}

export function definitionProblems(definition: NodeDefinition): string[] {
  const problems: string[] = [];
  const say = (message: string) => problems.push(`"${definition.kind}" ${message}`);

  if (!KIND_PATTERN.test(definition.kind)) say('has to be lower-case words joined by dashes');
  if (definition.kind === GROUP_KIND) say('is reserved for groups');
  if (!definition.title.trim()) say('has no title');
  if (!definition.describe.trim()) say('does not describe what it does');

  if (definition.role === 'value' && definition.exits.length > 0) {
    say('is a value node, so it cannot have exits — only steps decide where to go next');
  }
  if (definition.role === 'value' && definition.outputs.length === 0) {
    say('is a value node with no outputs, so nothing could ever read it');
  }

  for (const socket of [...definition.inputs, ...definition.outputs]) {
    if (!NAME_PATTERN.test(socket.name)) say(`has a socket named "${socket.name}", which is not a plain camelCase name`);
    if (!isSocketType(socket.type)) say(`has a socket "${socket.name}" of unknown type "${String(socket.type)}"`);
    if (!socket.describe.trim()) say(`does not describe its socket "${socket.name}"`);
  }
  for (const exit of definition.exits) {
    if (!NAME_PATTERN.test(exit.name)) say(`has an exit named "${exit.name}", which is not a plain camelCase name`);
    if (!exit.describe.trim()) say(`does not describe its exit "${exit.name}"`);
  }

  for (const spend of definition.spends ?? []) {
    if (!BUDGET_SPENDS.includes(spend)) say(`says it spends "${String(spend)}", which no budget limits`);
  }
  if (definition.spends && definition.role === 'value') say('is a value node, so it cannot spend budget — only steps can');

  for (const name of duplicates(definition.inputs.map((socket) => socket.name))) say(`has two inputs called "${name}"`);
  for (const name of duplicates(definition.outputs.map((socket) => socket.name))) say(`has two outputs called "${name}"`);
  for (const name of duplicates(definition.exits.map((exit) => exit.name))) say(`has two exits called "${name}"`);

  return problems;
}

export interface NodeCatalogue {
  get(kind: string): NodeDefinition | undefined;
  list(): readonly NodeDefinition[];
}

export class NodeCatalogueError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the node catalogue is not usable:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'NodeCatalogueError';
    this.problems = problems;
  }
}

export function createNodeCatalogue(definitions: readonly NodeDefinition[]): NodeCatalogue {
  const problems = [
    ...definitions.flatMap(definitionProblems),
    ...duplicates(definitions.map((definition) => definition.kind)).map((kind) => `"${kind}" is defined twice`),
  ];
  if (problems.length > 0) throw new NodeCatalogueError(problems);

  const byKind = new Map(definitions.map((definition) => [definition.kind, definition]));
  const ordered = [...definitions].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));

  return {
    get: (kind) => byKind.get(kind),
    list: () => ordered,
  };
}
