import { GROUP_KIND, type NodeDefinition } from './definition.js';
import { NO_SETTINGS } from './settings-schema.js';
import {
  isGroupInstance,
  type Body,
  type Flow,
  type GroupDefinition,
  type NodeId,
  type PlacedNode,
  type Procedure,
  type SocketRef,
  type Wire,
} from './schema.js';

export const GROUP_SEPARATOR = '.';
export const MAX_GROUP_EXPANSIONS = 2_000;

export class GroupExpansionError extends Error {
  readonly node: NodeId;

  constructor(message: string, node: NodeId) {
    super(message);
    this.name = 'GroupExpansionError';
    this.node = node;
  }
}

export function groupAsNode(group: GroupDefinition): NodeDefinition {
  return {
    kind: GROUP_KIND,
    title: group.title,
    category: 'custom',
    describe: group.describe,
    role: 'step',
    inputs: group.inputs.map(({ to: _to, ...socket }) => socket),
    outputs: group.outputs.map(({ from: _from, ...socket }) => socket),
    exits: group.exits.map(({ from: _from, ...exit }) => exit),
    settings: NO_SETTINGS,
    runs: 'workflow',
    idempotent: true,
    summarize: () => group.describe,
  };
}

export function groupLibrary(
  procedure: Pick<Procedure, 'groups'>,
  shared: readonly GroupDefinition[] = [],
): Map<string, GroupDefinition> {
  const library = new Map<string, GroupDefinition>();
  for (const group of shared) library.set(group.id, group);
  for (const group of procedure.groups) library.set(group.id, group);
  return library;
}

export interface Expanded<B extends Body> {
  body: B;
  origin: ReadonlyMap<NodeId, NodeId>;
}

const inside = (instance: NodeId, id: NodeId): NodeId => `${instance}${GROUP_SEPARATOR}${id}`;

function expandOne<B extends Body & { cleanup?: NodeId | undefined }>(
  body: B,
  instance: PlacedNode & { group: string },
  group: GroupDefinition,
): B {
  const at = (id: NodeId) => inside(instance.id, id);
  const ref = (socket: SocketRef): SocketRef => ({ node: at(socket.node), socket: socket.socket });

  const inputOf = (socket: string): SocketRef[] => {
    const exposed = group.inputs.find((input) => input.name === socket);
    if (!exposed) {
      throw new GroupExpansionError(`group "${group.id}" has no input called "${socket}"`, instance.id);
    }
    return exposed.to.map(ref);
  };

  const outputOf = (socket: string): SocketRef => {
    const exposed = group.outputs.find((output) => output.name === socket);
    if (!exposed) {
      throw new GroupExpansionError(`group "${group.id}" has no output called "${socket}"`, instance.id);
    }
    return ref(exposed.from);
  };

  const exitOf = (exit: string): { node: NodeId; exit: string } => {
    const exposed = group.exits.find((candidate) => candidate.name === exit);
    if (!exposed) {
      throw new GroupExpansionError(`group "${group.id}" has no exit called "${exit}"`, instance.id);
    }
    return { node: at(exposed.from.node), exit: exposed.from.exit };
  };

  const outerWires: Wire[] = body.wires.flatMap((wire) => {
    const from = wire.from.node === instance.id ? outputOf(wire.from.socket) : wire.from;
    if (wire.to.node !== instance.id) return [{ from, to: wire.to }];
    return inputOf(wire.to.socket).map((to) => ({ from, to }));
  });

  const outerFlow: Flow[] = body.flow.map((flow) => {
    const leaving = flow.from === instance.id ? exitOf(flow.exit) : { node: flow.from, exit: flow.exit };
    return {
      from: leaving.node,
      exit: leaving.exit,
      to: flow.to === instance.id ? at(group.start) : flow.to,
    };
  });

  const entry = at(group.start);

  return {
    ...body,
    start: body.start === instance.id ? entry : body.start,
    ...(body.cleanup !== undefined ? { cleanup: body.cleanup === instance.id ? entry : body.cleanup } : {}),
    nodes: [
      ...body.nodes.filter((node) => node.id !== instance.id),
      ...group.nodes.map((node) => ({ ...node, id: at(node.id) })),
    ],
    wires: [
      ...outerWires,
      ...group.wires.map((wire) => ({ from: ref(wire.from), to: ref(wire.to) })),
    ],
    flow: [
      ...outerFlow,
      ...group.flow.map((flow) => ({ from: at(flow.from), exit: flow.exit, to: at(flow.to) })),
    ],
  };
}

export function expandGroups<B extends Body & { cleanup?: NodeId | undefined }>(
  body: B,
  library: ReadonlyMap<string, GroupDefinition>,
): Expanded<B> {
  let current = body;
  const origin = new Map<NodeId, NodeId>(body.nodes.map((node) => [node.id, node.id]));
  const lineage = new Map<NodeId, readonly string[]>(body.nodes.map((node) => [node.id, []]));

  for (let expansions = 0; ; expansions += 1) {
    const instance = current.nodes.find(isGroupInstance);
    if (!instance) return { body: current, origin };

    if (expansions >= MAX_GROUP_EXPANSIONS) {
      throw new GroupExpansionError(
        `expanding groups produced more than ${MAX_GROUP_EXPANSIONS} group nodes, so it was stopped`,
        origin.get(instance.id) ?? instance.id,
      );
    }

    const group = library.get(instance.group);
    if (!group) {
      throw new GroupExpansionError(`uses group "${instance.group}", which does not exist`, origin.get(instance.id) ?? instance.id);
    }

    const ancestors = lineage.get(instance.id) ?? [];
    if (ancestors.includes(group.id)) {
      throw new GroupExpansionError(
        `group "${group.id}" contains itself (${[...ancestors, group.id].join(' → ')})`,
        origin.get(instance.id) ?? instance.id,
      );
    }

    current = expandOne(current, instance, group);

    const top = origin.get(instance.id) ?? instance.id;
    for (const node of group.nodes) {
      const id = inside(instance.id, node.id);
      origin.set(id, top);
      lineage.set(id, [...ancestors, group.id]);
    }
    origin.delete(instance.id);
    lineage.delete(instance.id);
  }
}
