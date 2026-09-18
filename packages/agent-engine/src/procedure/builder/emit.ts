import { GROUP_KIND, type NodeCatalogue, type NodeDefinition } from '../definition.js';
import { groupAsNode } from '../groups.js';
import type { Body, GroupDefinition, PlacedNode, Procedure, SocketRef } from '../schema.js';
import { camelKind } from './runtime.js';

export const BUILDER_MODULE = '@koala/procedure-builder';

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements',
  'interface', 'package', 'private', 'protected', 'public', 'await', 'async', 'arguments', 'eval', 'undefined', 'procedure',
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const quote = (text: string): string =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;

const asTemplate = (text: string): string =>
  `\`${text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;

const readable = (text: string): string => (text.includes('\n') ? asTemplate(text) : quote(text));

const key = (name: string): string => (IDENTIFIER.test(name) ? name : quote(name));

function literal(value: unknown, indent: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return readable(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => literal(item, `${indent}  `));
    const inline = `[${items.join(', ')}]`;
    return inline.length <= 80 && !inline.includes('\n') ? inline : `[\n${items.map((item) => `${indent}  ${item},`).join('\n')}\n${indent}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) return '{}';
    const items = entries.map(([name, entry]) => `${key(name)}: ${literal(entry, `${indent}  `)}`);
    const inline = `{ ${items.join(', ')} }`;
    return inline.length <= 80 && !inline.includes('\n') ? inline : `{\n${items.map((item) => `${indent}  ${item},`).join('\n')}\n${indent}}`;
  }
  return 'null';
}

interface EmitContext {
  catalogue: NodeCatalogue;
  shared: ReadonlyMap<string, GroupDefinition>;
  owned: ReadonlyMap<string, string>;
  ownedGroups: ReadonlyMap<string, GroupDefinition>;
  names: Set<string>;
}

function nameFor(wanted: string, taken: Set<string>): string {
  const base = IDENTIFIER.test(wanted) && !RESERVED.has(wanted) ? wanted : `node${wanted.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^[^A-Za-z_$]/, '_$&')}`;
  let name = base;
  let counter = 2;
  while (taken.has(name) || RESERVED.has(name)) {
    name = `${base}${counter}`;
    counter += 1;
  }
  taken.add(name);
  return name;
}

function emitBody(
  body: Body & { cleanup?: string | undefined },
  api: string,
  indent: string,
  context: EmitContext,
  group: GroupDefinition | undefined,
): string[] {
  const lines: string[] = [];
  const names = new Map<string, string>();
  const scope = new Set(context.names);
  for (const node of body.nodes) names.set(node.id, nameFor(node.id, scope));

  const definitionOf = (node: PlacedNode): NodeDefinition | undefined => {
    if (node.kind !== GROUP_KIND) return context.catalogue.get(node.kind);
    const owned = node.group ? context.owned.get(node.group) : undefined;
    if (owned) return undefined;
    const shared = node.group ? context.shared.get(node.group) : undefined;
    return shared ? groupAsNode(shared) : undefined;
  };

  const sourcesInto = new Map<string, string[]>();
  const add = (to: SocketRef, source: string) => {
    const at = JSON.stringify([to.node, to.socket]);
    sourcesInto.set(at, [...(sourcesInto.get(at) ?? []), source]);
  };
  const declaredBefore = new Map<string, number>(body.nodes.map((node, index) => [node.id, index]));
  const lateSources = new Set<string>();

  for (const input of group?.inputs ?? []) {
    for (const to of input.to) add(to, `${api}.inputs.${input.name}`);
  }
  for (const wire of body.wires) {
    add(wire.to, `${names.get(wire.from.node) ?? wire.from.node}.${wire.from.socket}`);
    const from = declaredBefore.get(wire.from.node) ?? Infinity;
    const to = declaredBefore.get(wire.to.node) ?? -1;
    if (from >= to) lateSources.add(JSON.stringify([wire.to.node, wire.to.socket]));
  }

  const inputsOf = (node: PlacedNode): { names: string[]; many: Set<string> } => {
    const definition = definitionOf(node);
    if (definition) return { names: definition.inputs.map((input) => input.name), many: new Set(definition.inputs.filter((input) => input.many).map((input) => input.name)) };
    const ownedGroup = node.group ? context.ownedGroups.get(node.group) : undefined;
    return { names: ownedGroup?.inputs.map((input) => input.name) ?? [], many: new Set(ownedGroup?.inputs.filter((input) => input.many).map((input) => input.name) ?? []) };
  };

  const wiresObject = (node: PlacedNode, late: boolean): string | undefined => {
    const { names: inputNames, many } = inputsOf(node);
    const extra = [...sourcesInto.keys()]
      .map((at) => JSON.parse(at) as [string, string])
      .filter(([id, socket]) => id === node.id && !inputNames.includes(socket))
      .map(([, socket]) => socket);
    const entries: string[] = [];
    for (const socket of [...inputNames, ...extra]) {
      const at = JSON.stringify([node.id, socket]);
      const sources = sourcesInto.get(at);
      if (!sources || lateSources.has(at) !== late) continue;
      entries.push(`${key(socket)}: ${many.has(socket) || sources.length > 1 ? `[${sources.join(', ')}]` : sources[0]}`);
    }
    if (entries.length === 0) return undefined;
    const inline = `{ ${entries.join(', ')} }`;
    return inline.length <= 90 ? inline : `{\n${entries.map((entry) => `${indent}  ${entry},`).join('\n')}\n${indent}}`;
  };

  const trimmed = (args: (string | undefined)[]): string => {
    const kept = [...args];
    while (kept.length > 1 && (kept.at(-1) === undefined || kept.at(-1) === '{}')) kept.pop();
    return kept.map((arg) => arg ?? '{}').join(', ');
  };

  for (const node of body.nodes) {
    const variable = names.get(node.id)!;
    const meta = {
      ...(node.label !== undefined ? { label: node.label } : {}),
      ...(node.notes !== undefined ? { notes: node.notes } : {}),
    };
    const wires = wiresObject(node, false);
    const metaText = literal(meta, indent);

    if (node.kind === GROUP_KIND) {
      const ownedVariable = node.group ? context.owned.get(node.group) : undefined;
      const args = trimmed([quote(node.id), wires, metaText]);
      lines.push(ownedVariable
        ? `${indent}const ${variable} = ${api}.use(${ownedVariable}, ${args})`
        : `${indent}const ${variable} = ${api}.groups.${camelKind(node.group ?? '')}(${args})`);
    } else {
      lines.push(`${indent}const ${variable} = ${api}.${camelKind(node.kind)}(${trimmed([quote(node.id), wires, literal(node.settings ?? {}, indent), metaText])})`);
    }
  }

  const late = body.nodes.flatMap((node) => {
    const wires = wiresObject(node, true);
    return wires ? [`${indent}${names.get(node.id)}.wire(${wires})`] : [];
  });
  if (late.length > 0) lines.push('', ...late);

  const routes: string[] = [];
  if (body.start) routes.push(`${indent}${api}.start(${names.get(body.start) ?? body.start})`);
  if (body.cleanup !== undefined) routes.push(`${indent}${api}.cleanup(${names.get(body.cleanup) ?? body.cleanup})`);
  for (const flow of body.flow) routes.push(`${indent}${names.get(flow.from)}.on(${quote(flow.exit)}, ${names.get(flow.to) ?? flow.to})`);
  for (const exit of group?.exits ?? []) routes.push(`${indent}${names.get(exit.from.node)}.on(${quote(exit.from.exit)}, ${api}.exits.${exit.name})`);
  for (const output of group?.outputs ?? []) routes.push(`${indent}${api}.output(${quote(output.name)}, ${names.get(output.from.node)}.${output.from.socket})`);
  if (routes.length > 0) lines.push('', ...routes);

  const positions = body.nodes.map((node) => `${indent}  ${key(node.id)}: [${node.position.x}, ${node.position.y}],`);
  if (positions.length > 0) lines.push('', `${indent}${api}.layout({`, ...positions, `${indent}})`);

  return lines;
}

export interface EmitOptions {
  catalogue: NodeCatalogue;
  groups?: readonly GroupDefinition[] | undefined;
}

export function procedureToBuilderCode(procedure: Procedure, options: EmitOptions): string {
  const shared = new Map((options.groups ?? []).map((group) => [group.id, group]));
  const taken = new Set(['p']);
  const owned = new Map<string, string>();
  const ownedGroups = new Map<string, GroupDefinition>();
  const lines: string[] = [];

  for (const group of procedure.groups) {
    const variable = nameFor(`${camelKind(group.id).replace(/[^A-Za-z0-9_$]/g, '')}Group`, taken);
    const context: EmitContext = { catalogue: options.catalogue, shared, owned, ownedGroups, names: new Set(taken) };
    const info = {
      title: group.title,
      describe: group.describe,
      ...(group.inputs.length ? { inputs: Object.fromEntries(group.inputs.map(({ name, to: _to, ...socket }) => [name, socket])) } : {}),
      ...(group.outputs.length ? { outputs: Object.fromEntries(group.outputs.map(({ name, from: _from, ...socket }) => [name, socket])) } : {}),
      ...(group.exits.length ? { exits: Object.fromEntries(group.exits.map(({ name, from: _from, ...exit }) => [name, exit])) } : {}),
    };
    lines.push(
      `  const ${variable} = p.group(${quote(group.id)}, ${literal(info, '  ')}, (g) => {`,
      ...emitBody(group, 'g', '    ', context, group),
      '  })',
      '',
    );
    owned.set(group.id, variable);
    ownedGroups.set(group.id, group);
  }

  const context: EmitContext = { catalogue: options.catalogue, shared, owned, ownedGroups, names: taken };
  lines.push(...emitBody(procedure, 'p', '  ', context, undefined));

  const meta = {
    id: procedure.id,
    version: procedure.version,
    name: procedure.name,
    describe: procedure.describe,
    budget: procedure.budget,
  };

  return [
    `import { procedure } from ${quote(BUILDER_MODULE)}`,
    '',
    `export default procedure(${literal(meta, '')}, (p) => {`,
    ...lines,
    '})',
    '',
  ].join('\n');
}
