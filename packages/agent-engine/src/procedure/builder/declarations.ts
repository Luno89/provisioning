import type { NodeCatalogue, NodeDefinition } from '../definition.js';
import type { GroupSetting, SettingSchema } from '../settings-schema.js';
import { SOCKET_TYPES } from '../sockets.js';
import type { GroupDefinition } from '../schema.js';
import { groupAsNode } from '../groups.js';
import { BUILDER_MODULE } from './emit.js';
import { camelKind } from './runtime.js';

const pascal = (text: string): string => {
  const camel = camelKind(text);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
};

const doc = (indent: string, ...lines: (string | undefined)[]): string => {
  const kept = lines.filter((line): line is string => Boolean(line?.trim())).map((line) => line.replace(/\*\//g, '* /'));
  if (kept.length === 0) return '';
  if (kept.length === 1) return `${indent}/** ${kept[0]} */\n`;
  return `${indent}/**\n${kept.map((line) => `${indent} * ${line}`).join('\n')}\n${indent} */\n`;
};

const quoted = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const property = (name: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quoted(name));

function settingType(schema: SettingSchema, indent: string): string {
  switch (schema.type) {
    case 'string':
      return schema.enum ? schema.enum.map(quoted).join(' | ') : 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `readonly (${settingType(schema.items, indent)})[]`;
    case 'object':
      return objectType(schema, indent);
  }
}

function objectType(schema: GroupSetting, indent: string): string {
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return 'Record<string, never>';
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  return `{\n${entries.map(([name, setting]) =>
    `${doc(inner, setting.title, setting.describe)}${inner}${property(name)}${required.has(name) ? '' : '?'}: ${settingType(setting, inner)}`).join('\n')}\n${indent}}`;
}

function nodeTypes(name: string, definition: NodeDefinition, withSettings: boolean): string {
  const wires = definition.inputs.length === 0
    ? `export type ${name}Wires = Record<string, never>`
    : `export interface ${name}Wires {\n${definition.inputs.map((input) =>
      `${doc('  ', `${input.describe}${input.required ? ' Required.' : ''}${input.many ? ' Takes any number of wires.' : ''}`)}  ${input.name}?: ${input.many ? `In<'${input.type}'> | readonly In<'${input.type}'>[]` : `In<'${input.type}'>`}`).join('\n')}\n}`;

  const exits = definition.exits.map((exit) => quoted(exit.name)).join(' | ');
  const base = definition.role === 'step' ? `Step<${exits || 'never'}>` : 'Value';
  const handle = `export interface ${name}Node extends ${base} {\n${definition.outputs.map((output) =>
    `${doc('  ', output.describe)}  readonly ${output.name}: Out<'${output.type}'>`).join('\n')}${definition.outputs.length ? '\n' : ''}  wire(wires: ${name}Wires): void\n}`;

  const settings = withSettings ? `export type ${name}Settings = ${objectType(definition.settings, '')}` : '';
  return [wires, settings, handle].filter(Boolean).join('\n\n');
}

function exitsDoc(definition: NodeDefinition): string[] {
  return definition.exits.map((exit) => `Leaves through ${exit.name}: ${exit.describe}`);
}

export function builderTypes(catalogue: NodeCatalogue, groups: readonly GroupDefinition[]): string {
  const definitions = catalogue.list();
  const parts: string[] = [
    `export type SocketType = ${SOCKET_TYPES.map(quoted).join(' | ')}`,
    'export interface Out<T extends SocketType> {\n  readonly __carries: T\n}',
    "export type In<T extends SocketType> = T extends 'any' ? Out<SocketType> : Out<T> | Out<'any'>",
    'export interface ExitTarget {\n  readonly __leavesTheGroup: true\n}',
    'export interface Step<E extends string> {\n  readonly id: string\n  on(exit: E, to: Step<string> | ExitTarget): void\n}',
    'export interface Value {\n  readonly id: string\n}',
    'export interface NodeMeta {\n  label?: string\n  notes?: string\n}',
    'export type Layout = Readonly<Record<string, readonly [number, number]>>',
    'export interface GroupSocket {\n  type: SocketType\n  describe: string\n  required?: boolean\n  many?: boolean\n}',
    'export interface GroupExitInfo {\n  describe: string\n}',
    'export type Sockets = Readonly<Record<string, GroupSocket>>',
    'export type Exits = Readonly<Record<string, GroupExitInfo>>',
    'export interface GroupInfo<I extends Sockets, O extends Sockets, E extends Exits> {\n  title: string\n  describe: string\n  inputs?: I\n  outputs?: O\n  exits?: E\n}',
    'export interface GroupRef<I extends Sockets, O extends Sockets, E extends Exits> {\n  readonly __group: [I, O, E]\n}',
    'export type GroupWires<I extends Sockets> = { [K in keyof I]?: In<I[K][\'type\']> | readonly In<I[K][\'type\']>[] }',
    'export type GroupNode<I extends Sockets, O extends Sockets, E extends Exits> = Step<Extract<keyof E, string>> & { readonly [K in keyof O]: Out<O[K][\'type\']> } & { wire(wires: GroupWires<I>): void }',
  ];

  for (const definition of definitions) parts.push(nodeTypes(pascal(definition.kind), definition, true));
  for (const group of groups) parts.push(nodeTypes(`${pascal(group.id)}Group`, groupAsNode(group), false));

  const methods = definitions.map((definition) => {
    const name = pascal(definition.kind);
    const settingsRequired = (definition.settings.required ?? []).length > 0;
    return `${doc('  ', `${definition.title}: ${definition.describe}`, ...exitsDoc(definition))}  ${camelKind(definition.kind)}(id: string, wires${settingsRequired ? '' : '?'}: ${name}Wires, settings${settingsRequired ? '' : '?'}: ${name}Settings, meta?: NodeMeta): ${name}Node`;
  });
  parts.push(`export interface Nodes {\n${methods.join('\n')}\n}`);

  const groupMethods = groups.map((group) =>
    `${doc('  ', `${group.title}: ${group.describe}`, ...group.exits.map((exit) => `Leaves through ${exit.name}: ${exit.describe}`))}  ${camelKind(group.id)}(id: string, wires?: ${pascal(group.id)}GroupWires, meta?: NodeMeta): ${pascal(group.id)}GroupNode`);
  parts.push(`export interface BuiltInGroups {\n${groupMethods.join('\n')}\n}`);

  parts.push(
    [
      'export interface Body extends Nodes {',
      `${doc('  ', 'The built-in groups, each used as one node.')}  readonly groups: BuiltInGroups`,
      `${doc('  ', 'Defines a group of nodes that can be used as one node, then returns it for use(…).')}  group<const I extends Sockets = {}, const O extends Sockets = {}, const E extends Exits = {}>(id: string, info: GroupInfo<I, O, E>, build: (g: GroupBody<I, O, E>) => void): GroupRef<I, O, E>`,
      `${doc('  ', 'Places one of this procedure\'s own groups as a node.')}  use<I extends Sockets, O extends Sockets, E extends Exits>(group: GroupRef<I, O, E>, id: string, wires?: GroupWires<I>, meta?: NodeMeta): GroupNode<I, O, E>`,
      `${doc('  ', 'Where each node sits on the canvas.')}  layout(positions: Layout): void`,
      '}',
    ].join('\n'),
    [
      'export interface ProcedureBody extends Body {',
      `${doc('  ', 'The step the procedure starts at.')}  start(step: Step<string>): void`,
      `${doc('  ', 'The step that runs last, however the procedure ends.')}  cleanup(step: Step<string>): void`,
      '}',
    ].join('\n'),
    [
      'export interface GroupBody<I extends Sockets, O extends Sockets, E extends Exits> extends Body {',
      `${doc('  ', 'What the group is given, to wire into the nodes inside it.')}  readonly inputs: { readonly [K in keyof I]: Out<I[K]['type']> }`,
      `${doc('  ', 'Where an exit leaves the group, as in call.on(\'answered\', g.exits.answered).')}  readonly exits: { readonly [K in keyof E]: ExitTarget }`,
      `${doc('  ', 'Hands a value from inside the group out through one of its outputs.')}  output<K extends Extract<keyof O, string>>(name: K, from: In<O[K]['type']>): void`,
      `${doc('  ', 'The step the group starts at.')}  start(step: Step<string>): void`,
      '}',
    ].join('\n'),
    'export interface Budget {\n  maxRounds?: number\n  maxToolCalls?: number\n  maxTokens?: number\n  maxWallClockMs?: number\n  maxDepth?: number\n  maxChildRuns?: number\n}',
    'export interface ProcedureMeta {\n  id: string\n  version?: string\n  name?: string\n  describe?: string\n  budget?: Budget\n}',
  );

  return `${parts.join('\n\n')}\n`;
}

export function builderModuleDeclarations(catalogue: NodeCatalogue, groups: readonly GroupDefinition[]): string {
  const body = builderTypes(catalogue, groups).split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
  return [
    `declare module ${quoted(BUILDER_MODULE)} {`,
    body,
    '  export interface ProcedureDefinition {\n    readonly __procedure: true\n  }',
    '',
    `${doc('  ', 'Defines a procedure. The body is read, never run: only const, the builder\'s calls, .on(…), .wire(…) and plain values are allowed.')}  export function procedure(meta: ProcedureMeta, build: (p: ProcedureBody) => void): ProcedureDefinition`,
    '}',
    '',
  ].join('\n');
}
