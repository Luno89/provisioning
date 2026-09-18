import { GROUP_KIND, type NodeCatalogue, type NodeDefinition } from '../definition.js';
import { groupAsNode } from '../groups.js';
import {
  PROCEDURE_SCHEMA,
  type Flow,
  type GroupDefinition,
  type GroupExit,
  type GroupInput,
  type GroupOutput,
  type PlacedNode,
  type Procedure,
  type SocketRef,
  type Wire,
} from '../schema.js';
import { isSocketType, socketAccepts, type SocketType } from '../sockets.js';
import type { RunBudget } from '../../runtime/run.js';

export class BuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderError';
  }
}

export const HANDLE_MEMBERS = ['id', 'on', 'wire'] as const;

export const camelKind = (kind: string): string => kind.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

export interface NodeMeta {
  label?: string | undefined;
  notes?: string | undefined;
}

export interface ProcedureMeta {
  id: string;
  version?: string | undefined;
  name?: string | undefined;
  describe?: string | undefined;
  budget?: RunBudget | undefined;
}

export interface GroupSocketInfo {
  type: SocketType;
  describe: string;
  required?: boolean | undefined;
  many?: boolean | undefined;
}

export interface GroupInfo {
  title: string;
  describe: string;
  inputs?: Readonly<Record<string, GroupSocketInfo>> | undefined;
  outputs?: Readonly<Record<string, GroupSocketInfo>> | undefined;
  exits?: Readonly<Record<string, { describe: string }>> | undefined;
}

interface OutputRef {
  readonly kind: 'output';
  readonly body: BodyBuilder;
  readonly node: string;
  readonly socket: string;
  readonly type: SocketType;
}

interface GroupInputRef {
  readonly kind: 'group-input';
  readonly body: BodyBuilder;
  readonly name: string;
  readonly type: SocketType;
}

interface GroupRef {
  readonly kind: 'group';
  readonly group: GroupDefinition;
}

interface GroupExitRef {
  readonly kind: 'group-exit';
  readonly body: BodyBuilder;
  readonly name: string;
}

type Source = OutputRef | GroupInputRef;

export interface BuiltHandle {
  readonly id: string;
  readonly definition: NodeDefinition;
  readonly body: BodyBuilder;
}

const builderValues = new WeakSet<object>();
const builderFunctions = new WeakSet<(...args: never[]) => unknown>();

export const isBuilderValue = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && builderValues.has(value);

export const isBuilderFunction = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function' && builderFunctions.has(value as never);

function tagged<T extends object>(value: T): T {
  builderValues.add(value);
  return value;
}

function callable<T extends (...args: never[]) => unknown>(fn: T): T {
  builderFunctions.add(fn);
  return fn;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSource = (value: unknown): value is Source =>
  isRecord(value) && (value.kind === 'output' || value.kind === 'group-input') && 'body' in value;

const isExitRef = (value: unknown): value is GroupExitRef => isRecord(value) && value.kind === 'group-exit';

const handles = new WeakMap<object, BuiltHandle>();

export const handleOf = (value: unknown): BuiltHandle | undefined =>
  typeof value === 'object' && value !== null ? handles.get(value) : undefined;

export interface BuilderOptions {
  catalogue: NodeCatalogue;
  groups?: readonly GroupDefinition[] | undefined;
}

class BodyBuilder {
  readonly nodes: PlacedNode[] = [];
  readonly wires: Wire[] = [];
  readonly flow: Flow[] = [];
  readonly definitions = new Map<string, NodeDefinition>();
  readonly groupInputs = new Map<string, { info: GroupSocketInfo; to: SocketRef[] }>();
  readonly groupOutputs = new Map<string, { info: GroupSocketInfo; from?: SocketRef }>();
  readonly groupExits = new Map<string, { describe: string; from?: { node: string; exit: string } }>();
  readonly unplaced: string[] = [];
  start: string | undefined;
  cleanup: string | undefined;
  readonly where: string;

  constructor(where: string) {
    this.where = where;
  }

  addNode(definition: NodeDefinition, kind: string, id: unknown, wires: unknown, rawSettings: unknown, rawMeta: unknown, group?: string): object {
    if (typeof id !== 'string' || !id.trim()) throw new BuilderError(`a ${definition.title} node needs an id as its first argument`);
    if (this.definitions.has(id)) throw new BuilderError(`two nodes ${this.where} are called "${id}"`);
    if (rawSettings !== undefined && !isRecord(rawSettings)) throw new BuilderError(`"${id}"'s settings have to be an object`);
    if (rawMeta !== undefined && !isRecord(rawMeta)) throw new BuilderError(`"${id}"'s label, notes and position have to be an object`);
    const settings = rawSettings as Record<string, unknown> | undefined;
    const meta = rawMeta as Record<string, unknown> | undefined;

    if (meta?.label !== undefined && typeof meta.label !== 'string') throw new BuilderError(`"${id}"'s label has to be text`);
    if (meta?.notes !== undefined && typeof meta.notes !== 'string') throw new BuilderError(`"${id}"'s notes have to be text`);
    for (const key of Object.keys(meta ?? {})) {
      if (!['label', 'notes'].includes(key)) throw new BuilderError(`"${id}" has "${key}" beside its settings, but only label and notes can go there`);
    }

    this.definitions.set(id, definition);
    this.nodes.push({
      id,
      kind,
      ...(group ? { group } : {}),
      ...(typeof meta?.label === 'string' ? { label: meta.label } : {}),
      ...(typeof meta?.notes === 'string' ? { notes: meta.notes } : {}),
      settings: { ...(settings ?? {}) },
      position: { x: 0, y: 0 },
    });
    this.unplaced.push(id);

    const handle: Record<string, unknown> = { id };
    for (const output of definition.outputs) {
      if ((HANDLE_MEMBERS as readonly string[]).includes(output.name)) {
        throw new BuilderError(`${definition.title} has an output called "${output.name}", which the builder uses for something else`);
      }
      handle[output.name] = tagged<OutputRef>({ kind: 'output', body: this, node: id, socket: output.name, type: output.type });
    }
    handle.wire = callable((more: unknown) => {
      this.connect(id, more);
    });
    if (definition.role === 'step') {
      handle.on = callable((exit: unknown, target: unknown) => {
        this.route(id, exit, target);
      });
    }
    const built = tagged(handle);
    handles.set(built, { id, definition, body: this });

    this.connect(id, wires);
    return built;
  }

  connect(id: string, wires: unknown): void {
    if (wires === undefined) return;
    if (!isRecord(wires)) throw new BuilderError(`what is wired into "${id}" has to be an object of socket names`);
    const definition = this.definitions.get(id)!;

    for (const [name, value] of Object.entries(wires)) {
      const spec = definition.inputs.find((input) => input.name === name);
      if (!spec) {
        const takes = definition.inputs.map((input) => input.name);
        throw new BuilderError(`${definition.title} "${id}" has no input called "${name}"${takes.length ? ` — it takes ${takes.join(', ')}` : ''}`);
      }
      const sources = Array.isArray(value) ? value : [value];
      if (Array.isArray(value) && !spec.many) throw new BuilderError(`"${id}.${name}" takes one wire, not a list`);

      for (const source of sources) {
        if (!isSource(source)) throw new BuilderError(`"${id}.${name}" has to be wired from another node's output, like turn.reply`);
        if (source.body !== this) throw new BuilderError(`"${id}.${name}" is wired from a node in a different ${source.body.where === this.where ? 'place' : source.body.where}`);
        if (!socketAccepts(spec.type, source.type)) {
          const from = source.kind === 'output' ? `${source.node}.${source.socket}` : `the group's input ${source.name}`;
          throw new BuilderError(`"${id}.${name}" takes ${spec.type}, but ${from} gives ${source.type}`);
        }
        if (source.kind === 'output') {
          this.wires.push({ from: { node: source.node, socket: source.socket }, to: { node: id, socket: name } });
        } else {
          this.groupInputs.get(source.name)!.to.push({ node: id, socket: name });
        }
      }
    }
  }

  route(id: string, exit: unknown, target: unknown): void {
    const definition = this.definitions.get(id)!;
    if (typeof exit !== 'string' || !definition.exits.some((candidate) => candidate.name === exit)) {
      throw new BuilderError(`${definition.title} "${id}" has no exit called "${String(exit)}" — it leaves through ${definition.exits.map((candidate) => candidate.name).join(', ')}`);
    }
    if (isExitRef(target)) {
      if (target.body !== this) throw new BuilderError(`"${id}" can only leave its own group`);
      const declared = this.groupExits.get(target.name)!;
      if (declared.from) throw new BuilderError(`the group's exit "${target.name}" is already reached from "${declared.from.node}"`);
      declared.from = { node: id, exit };
      return;
    }
    const to = handleOf(target);
    if (!to) throw new BuilderError(`"${id}" can only lead to a step, like ${id}.on('${exit}', finished)`);
    if (to.body !== this) throw new BuilderError(`"${id}" can only lead to a step in the same place`);
    if (to.definition.role !== 'step') throw new BuilderError(`"${to.id}" is a value node, so nothing can lead to it`);
    this.flow.push({ from: id, exit, to: to.id });
  }

  layout(positions: unknown): void {
    if (!isRecord(positions)) throw new BuilderError('layout takes each node\'s id and its [x, y]');
    for (const [id, at] of Object.entries(positions)) {
      const node = this.nodes.find((candidate) => candidate.id === id);
      if (!node) throw new BuilderError(`layout places "${id}", but there is no node called that ${this.where}`);
      if (!Array.isArray(at) || at.length !== 2 || !at.every((value) => typeof value === 'number')) {
        throw new BuilderError(`"${id}"'s position has to be written as [x, y]`);
      }
      node.position = { x: at[0] as number, y: at[1] as number };
      const index = this.unplaced.indexOf(id);
      if (index >= 0) this.unplaced.splice(index, 1);
    }
  }

  setEntry(which: 'start' | 'cleanup', target: unknown): void {
    const handle = handleOf(target);
    if (!handle || handle.body !== this) throw new BuilderError(`the ${which} has to be a step declared here`);
    if (handle.definition.role !== 'step') throw new BuilderError(`"${handle.id}" is a value node, so it cannot be the ${which}`);
    if (this[which] !== undefined) throw new BuilderError(`the ${which} is already "${this[which]}"`);
    this[which] = handle.id;
  }
}

function socketsOf(what: string, value: unknown, withSockets: boolean): Record<string, GroupSocketInfo> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new BuilderError(`the group's ${what} have to be an object`);
  for (const [name, info] of Object.entries(value)) {
    if (!isRecord(info) || typeof info.describe !== 'string') throw new BuilderError(`the group's ${what.slice(0, -1)} "${name}" needs a describe`);
    if (withSockets && !isSocketType(info.type)) throw new BuilderError(`the group's ${what.slice(0, -1)} "${name}" needs a type`);
  }
  return value as Record<string, GroupSocketInfo>;
}

export interface BuiltProcedure {
  procedure: Procedure;
  unplaced: string[];
}

function builderParts(options: BuilderOptions) {
  const shared = options.groups ?? [];

  const bodyApi = (body: BodyBuilder, owned: GroupDefinition[]): Record<string, unknown> => {
    const api: Record<string, unknown> = {};
    api.layout = callable((positions: unknown) => body.layout(positions));

    for (const definition of options.catalogue.list()) {
      api[camelKind(definition.kind)] = callable((id: unknown, wires?: unknown, settings?: unknown, meta?: unknown) =>
        body.addNode(definition, definition.kind, id, wires, settings, meta));
    }

    const instanceOf = (group: GroupDefinition) =>
      callable((id: unknown, wires?: unknown, meta?: unknown) => body.addNode(groupAsNode(group), GROUP_KIND, id, wires, undefined, meta, group.id));

    const groups: Record<string, unknown> = {};
    for (const group of shared) groups[camelKind(group.id)] = instanceOf(group);
    api.groups = tagged(groups);

    api.group = callable((id: unknown, info: unknown, build: unknown) => {
      if (typeof id !== 'string' || !id.trim()) throw new BuilderError('a group needs an id as its first argument');
      if (owned.some((group) => group.id === id)) throw new BuilderError(`two groups are called "${id}"`);
      if (!isRecord(info) || typeof info.title !== 'string' || typeof info.describe !== 'string') {
        throw new BuilderError(`group "${id}" needs a title and a describe`);
      }
      if (typeof build !== 'function') throw new BuilderError(`group "${id}" needs a body, like (g) => { … }`);

      const inner = new BodyBuilder(`in group "${id}"`);
      const inputs = socketsOf('inputs', info.inputs, true);
      const outputs = socketsOf('outputs', info.outputs, true);
      const exits = socketsOf('exits', info.exits, false) as unknown as Record<string, { describe: string }>;

      const g = bodyApi(inner, owned);
      const inputRefs: Record<string, unknown> = {};
      for (const [name, socket] of Object.entries(inputs)) {
        inner.groupInputs.set(name, { info: socket, to: [] });
        inputRefs[name] = tagged<GroupInputRef>({ kind: 'group-input', body: inner, name, type: socket.type });
      }
      for (const [name, socket] of Object.entries(outputs)) inner.groupOutputs.set(name, { info: socket });
      const exitRefs: Record<string, unknown> = {};
      for (const [name, exit] of Object.entries(exits)) {
        inner.groupExits.set(name, { describe: exit.describe });
        exitRefs[name] = tagged<GroupExitRef>({ kind: 'group-exit', body: inner, name });
      }
      g.inputs = tagged(inputRefs);
      g.exits = tagged(exitRefs);
      g.output = callable((name: unknown, from: unknown) => {
        const declared = typeof name === 'string' ? inner.groupOutputs.get(name) : undefined;
        if (!declared) throw new BuilderError(`group "${id}" has no output called "${String(name)}"`);
        if (declared.from) throw new BuilderError(`the group's output "${String(name)}" is already given a value`);
        if (!isSource(from) || from.kind !== 'output' || from.body !== inner) {
          throw new BuilderError(`the group's output "${String(name)}" has to come from a node inside the group`);
        }
        if (!socketAccepts(declared.info.type, from.type)) {
          throw new BuilderError(`the group's output "${String(name)}" carries ${declared.info.type}, but ${from.node}.${from.socket} gives ${from.type}`);
        }
        declared.from = { node: from.node, socket: from.socket };
      });
      g.start = callable((target: unknown) => inner.setEntry('start', target));

      (build as (api: unknown) => void)(tagged(g));

      if (inner.start === undefined) throw new BuilderError(`group "${id}" never says where it starts — add g.start(…)`);
      for (const [name, output] of inner.groupOutputs) {
        if (!output.from) throw new BuilderError(`the group's output "${name}" is never given a value — add g.output('${name}', …)`);
      }
      for (const [name, exit] of inner.groupExits) {
        if (!exit.from) throw new BuilderError(`nothing leaves group "${id}" through "${name}" — route an exit to g.exits.${name}`);
      }
      body.unplaced.push(...inner.unplaced.map((node) => `${id}/${node}`));

      const group: GroupDefinition = {
        id,
        title: info.title,
        describe: info.describe,
        start: inner.start,
        nodes: inner.nodes,
        wires: inner.wires,
        flow: inner.flow,
        inputs: [...inner.groupInputs].map(([name, { info: socket, to }]): GroupInput => ({ name, ...socket, to })),
        outputs: [...inner.groupOutputs].map(([name, { info: socket, from }]): GroupOutput => ({ name, ...socket, from: from! })),
        exits: [...inner.groupExits].map(([name, exit]): GroupExit => ({ name, describe: exit.describe, from: exit.from! })),
      };
      owned.push(group);
      return tagged<GroupRef>({ kind: 'group', group });
    });

    api.use = callable((ref: unknown, id: unknown, wires?: unknown, meta?: unknown) => {
      if (!isRecord(ref) || ref.kind !== 'group' || !isBuilderValue(ref)) {
        throw new BuilderError('use takes a group made with group(…), then the new node\'s id');
      }
      return body.addNode(groupAsNode((ref as unknown as GroupRef).group), GROUP_KIND, id, wires, undefined, meta, (ref as unknown as GroupRef).group.id);
    });

    return api;
  };

  return { bodyApi };
}

export function createGroupBuilder(options: BuilderOptions) {
  const { bodyApi } = builderParts(options);

  return function group(id: string, info: GroupInfo, build: (g: never) => void): GroupDefinition {
    const outside = new BodyBuilder('beside the group');
    const owned: GroupDefinition[] = [];
    (bodyApi(outside, owned).group as (...args: unknown[]) => unknown)(id, info, build);
    if (owned.length !== 1) throw new BuilderError(`group "${id}" defines other groups inside it, which a shared group cannot do`);
    const unplaced = outside.unplaced;
    if (unplaced.length > 0) throw new BuilderError(`group "${id}" never places ${unplaced.map((node) => `"${node.split('/').pop()}"`).join(', ')} — add them to g.layout(…)`);
    return owned[0]!;
  };
}

export function createProcedureBuilder(options: BuilderOptions) {
  const { bodyApi } = builderParts(options);

  return function procedure(meta: ProcedureMeta, build: (p: never) => void): BuiltProcedure {
    if (!isRecord(meta) || typeof meta.id !== 'string' || !meta.id.trim()) throw new BuilderError('a procedure needs an id');
    for (const key of Object.keys(meta)) {
      if (!['id', 'version', 'name', 'describe', 'budget'].includes(key)) throw new BuilderError(`a procedure has no "${key}" — it takes id, version, name, describe and budget`);
    }
    if (typeof build !== 'function') throw new BuilderError('a procedure needs a body, like (p) => { … }');

    const body = new BodyBuilder('in the procedure');
    const owned: GroupDefinition[] = [];
    const p = bodyApi(body, owned);
    p.start = callable((target: unknown) => body.setEntry('start', target));
    p.cleanup = callable((target: unknown) => body.setEntry('cleanup', target));

    build(tagged(p) as never);

    if (body.start === undefined) throw new BuilderError('the procedure never says where it starts — add p.start(…)');

    return {
      procedure: {
        schema: PROCEDURE_SCHEMA,
        id: meta.id,
        version: meta.version ?? '1',
        name: meta.name ?? meta.id,
        describe: meta.describe ?? '',
        budget: { ...(meta.budget ?? {}) },
        start: body.start,
        ...(body.cleanup !== undefined ? { cleanup: body.cleanup } : {}),
        nodes: body.nodes,
        wires: body.wires,
        flow: body.flow,
        groups: owned,
      },
      unplaced: body.unplaced,
    };
  };
}

export type ProcedureBuilderFunction = ReturnType<typeof createProcedureBuilder>;
