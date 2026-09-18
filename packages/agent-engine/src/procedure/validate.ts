import type { RunBudget } from '../runtime/run.js';
import { GROUP_KIND, definitionFor as shapedFor, type KnownReferences, type NodeCatalogue, type NodeDefinition, type SocketSpec } from './definition.js';
import { expandGroups, GROUP_SEPARATOR, GroupExpansionError, groupAsNode, groupLibrary } from './groups.js';
import {
  PROCEDURE_SCHEMA,
  type Body,
  type GroupDefinition,
  type NodeId,
  type PlacedNode,
  type Procedure,
} from './schema.js';
import { settingsProblems } from './settings-schema.js';
import { socketAccepts } from './sockets.js';

export interface ProcedureProblem {
  severity: 'error' | 'warning';
  message: string;
  group?: string | undefined;
  node?: NodeId | undefined;
  socket?: string | undefined;
  exit?: string | undefined;
}

export interface CheckOptions {
  catalogue: NodeCatalogue;
  groups?: readonly GroupDefinition[] | undefined;
  known?: KnownReferences | undefined;
}

interface Scope {
  catalogue: NodeCatalogue;
  library: ReadonlyMap<string, GroupDefinition>;
  known: KnownReferences;
  group?: GroupDefinition | undefined;
}

const key = (node: NodeId, name: string): string => JSON.stringify([node, name]);

const isBounded = (budget: RunBudget): boolean =>
  budget.maxRounds !== undefined
  || budget.maxTokens !== undefined
  || budget.maxToolCalls !== undefined
  || budget.maxWallClockMs !== undefined;

export const procedureErrors = (problems: readonly ProcedureProblem[]): ProcedureProblem[] =>
  problems.filter((problem) => problem.severity === 'error');

function definitionFor(node: PlacedNode, scope: Scope): NodeDefinition | string {
  if (node.kind === GROUP_KIND) {
    if (!node.group) return 'is a group node but does not say which group';
    const group = scope.library.get(node.group);
    return group ? groupAsNode(group) : `uses group "${node.group}", which does not exist`;
  }
  if (node.group !== undefined) return `names group "${node.group}" but is a "${node.kind}" node, not a group`;
  return shapedFor(scope.catalogue, node) ?? `is a "${node.kind}" node, which is not a kind of node`;
}

function checkBody(body: Body & { cleanup?: NodeId | undefined }, scope: Scope): ProcedureProblem[] {
  const problems: ProcedureProblem[] = [];
  const tag = scope.group ? { group: scope.group.id } : {};
  const error = (message: string, where: Omit<ProcedureProblem, 'severity' | 'message'> = {}) =>
    problems.push({ severity: 'error', message, ...tag, ...where });
  const warn = (message: string, where: Omit<ProcedureProblem, 'severity' | 'message'> = {}) =>
    problems.push({ severity: 'warning', message, ...tag, ...where });

  const nodes = new Map<NodeId, PlacedNode>();
  const definitions = new Map<NodeId, NodeDefinition>();

  for (const node of body.nodes) {
    if (!node.id.trim()) {
      error('a node has no id');
      continue;
    }
    if (node.id.includes(GROUP_SEPARATOR)) {
      error(`has "${GROUP_SEPARATOR}" in its id, which is reserved for nodes inside groups`, { node: node.id });
    }
    if (nodes.has(node.id)) {
      error(`two nodes share the id "${node.id}"`, { node: node.id });
      continue;
    }
    nodes.set(node.id, node);

    const found = definitionFor(node, scope);
    if (typeof found === 'string') {
      error(found, { node: node.id });
      continue;
    }
    definitions.set(node.id, found);

    for (const message of settingsProblems(found.settings, node.settings ?? {})) error(message, { node: node.id });
    for (const message of found.check?.(node.settings ?? {}, scope.known) ?? []) error(message, { node: node.id });
  }

  const isStep = (id: NodeId) => definitions.get(id)?.role === 'step';
  const inputSpec = (id: NodeId, socket: string): SocketSpec | undefined =>
    definitions.get(id)?.inputs.find((spec) => spec.name === socket);
  const outputSpec = (id: NodeId, socket: string): SocketSpec | undefined =>
    definitions.get(id)?.outputs.find((spec) => spec.name === socket);

  const exposedInputs = new Set<string>();
  const exposedOutputs = new Set<string>();
  const exposedExits = new Set<string>();

  if (scope.group) {
    const group = scope.group;
    const names = (list: readonly { name: string }[], what: string) => {
      const seen = new Set<string>();
      for (const { name } of list) {
        if (seen.has(name)) error(`the group has two ${what} called "${name}"`);
        seen.add(name);
      }
    };
    names(group.inputs, 'inputs');
    names(group.outputs, 'outputs');
    names(group.exits, 'exits');

    for (const input of group.inputs) {
      if (input.required && input.to.length === 0) {
        error(`the group's required input "${input.name}" is not connected to anything inside it`);
      }
      for (const target of input.to) {
        if (!nodes.has(target.node)) {
          error(`the group's input "${input.name}" goes to "${target.node}", which does not exist`);
          continue;
        }
        const spec = inputSpec(target.node, target.socket);
        if (!spec) {
          if (definitions.has(target.node)) {
            error(`the group's input "${input.name}" goes to "${target.socket}", which this node does not take`, { node: target.node, socket: target.socket });
          }
          continue;
        }
        if (!socketAccepts(spec.type, input.type)) {
          error(`the group's input "${input.name}" carries ${input.type}, but this socket takes ${spec.type}`, { node: target.node, socket: target.socket });
        }
        exposedInputs.add(key(target.node, target.socket));
      }
    }

    for (const output of group.outputs) {
      if (!nodes.has(output.from.node)) {
        error(`the group's output "${output.name}" comes from "${output.from.node}", which does not exist`);
        continue;
      }
      const spec = outputSpec(output.from.node, output.from.socket);
      if (!spec) {
        if (definitions.has(output.from.node)) {
          error(`the group's output "${output.name}" comes from "${output.from.socket}", which this node does not produce`, { node: output.from.node, socket: output.from.socket });
        }
        continue;
      }
      if (!socketAccepts(output.type, spec.type)) {
        error(`the group's output "${output.name}" carries ${output.type}, but this socket produces ${spec.type}`, { node: output.from.node, socket: output.from.socket });
      }
      exposedOutputs.add(key(output.from.node, output.from.socket));
    }

    for (const exit of group.exits) {
      const from = exit.from;
      if (!nodes.has(from.node)) {
        error(`the group's exit "${exit.name}" leaves from "${from.node}", which does not exist`);
        continue;
      }
      const definition = definitions.get(from.node);
      if (!definition) continue;
      if (!definition.exits.some((candidate) => candidate.name === from.exit)) {
        error(`the group's exit "${exit.name}" uses "${from.exit}", which this node does not have`, { node: from.node, exit: from.exit });
        continue;
      }
      exposedExits.add(key(from.node, from.exit));
    }
  }

  const wiresInto = new Map<string, number>();
  const readFrom = new Set<NodeId>();
  const valueFeeds = new Map<NodeId, NodeId[]>();

  for (const wire of body.wires) {
    const where = { node: wire.to.node, socket: wire.to.socket };
    if (!nodes.has(wire.from.node)) {
      error(`is wired from "${wire.from.node}", which does not exist`, where);
      continue;
    }
    if (!nodes.has(wire.to.node)) {
      error(`is wired into "${wire.to.node}", which does not exist`, { node: wire.from.node, socket: wire.from.socket });
      continue;
    }
    if (!definitions.has(wire.from.node) || !definitions.has(wire.to.node)) continue;

    const produced = outputSpec(wire.from.node, wire.from.socket);
    const taken = inputSpec(wire.to.node, wire.to.socket);
    if (!produced) {
      error(`is wired from "${wire.from.socket}", which "${wire.from.node}" does not produce`, { node: wire.from.node, socket: wire.from.socket });
      continue;
    }
    if (!taken) {
      error(`is wired into "${wire.to.socket}", which this node does not take`, where);
      continue;
    }
    if (!socketAccepts(taken.type, produced.type)) {
      error(`takes ${taken.type}, but "${wire.from.node}.${wire.from.socket}" produces ${produced.type}`, where);
    }

    wiresInto.set(key(wire.to.node, wire.to.socket), (wiresInto.get(key(wire.to.node, wire.to.socket)) ?? 0) + 1);
    readFrom.add(wire.from.node);

    if (!isStep(wire.from.node) && !isStep(wire.to.node)) {
      valueFeeds.set(wire.from.node, [...(valueFeeds.get(wire.from.node) ?? []), wire.to.node]);
    }
  }

  for (const [id, definition] of definitions) {
    for (const spec of definition.inputs) {
      const count = (wiresInto.get(key(id, spec.name)) ?? 0) + (exposedInputs.has(key(id, spec.name)) ? 1 : 0);
      if (count > 1 && !spec.many) {
        error(`has ${count} wires into "${spec.name}", which takes only one`, { node: id, socket: spec.name });
      }
      if (count === 0 && spec.required) {
        error(`needs "${spec.name}", and nothing is wired into it`, { node: id, socket: spec.name });
      }
    }

    if (definition.role === 'value') {
      const read = readFrom.has(id) || definition.outputs.some((spec) => exposedOutputs.has(key(id, spec.name)));
      if (!read) warn('nothing reads what this produces', { node: id });
    }
  }

  const visiting = new Set<NodeId>();
  const settled = new Set<NodeId>();
  const reportedCycle = new Set<NodeId>();
  const walkValues = (id: NodeId, path: NodeId[]): void => {
    if (settled.has(id)) return;
    if (visiting.has(id)) {
      const loop = [...path.slice(path.indexOf(id)), id];
      if (!reportedCycle.has(id)) {
        error(`value nodes feed each other in a circle (${loop.join(' → ')}), so none of them could ever be worked out`, { node: id });
        for (const member of loop) reportedCycle.add(member);
      }
      return;
    }
    visiting.add(id);
    for (const next of valueFeeds.get(id) ?? []) walkValues(next, [...path, id]);
    visiting.delete(id);
    settled.add(id);
  };
  for (const id of valueFeeds.keys()) walkValues(id, []);

  const leaving = new Map<NodeId, NodeId[]>();
  const flowed = new Set<string>();

  for (const flow of body.flow) {
    if (!nodes.has(flow.from)) {
      error(`a flow leaves "${flow.from}", which does not exist`);
      continue;
    }
    if (!nodes.has(flow.to)) {
      error(`leaves through "${flow.exit}" to "${flow.to}", which does not exist`, { node: flow.from, exit: flow.exit });
      continue;
    }
    const from = definitions.get(flow.from);
    const to = definitions.get(flow.to);
    if (!from || !to) continue;

    if (from.role !== 'step') {
      error('is a value node, so it cannot lead anywhere — only steps run in order', { node: flow.from });
      continue;
    }
    if (!from.exits.some((exit) => exit.name === flow.exit)) {
      error(`has no exit called "${flow.exit}"`, { node: flow.from, exit: flow.exit });
      continue;
    }
    if (to.role !== 'step') {
      error(`leads to "${flow.to}", which is a value node and never runs on its own`, { node: flow.from, exit: flow.exit });
      continue;
    }
    if (flowed.has(key(flow.from, flow.exit))) {
      error(`leaves through "${flow.exit}" to more than one place`, { node: flow.from, exit: flow.exit });
      continue;
    }
    if (exposedExits.has(key(flow.from, flow.exit))) {
      error(`"${flow.exit}" already leaves the group, so it cannot also lead somewhere inside it`, { node: flow.from, exit: flow.exit });
      continue;
    }

    flowed.add(key(flow.from, flow.exit));
    leaving.set(flow.from, [...(leaving.get(flow.from) ?? []), flow.to]);
  }

  for (const [id, definition] of definitions) {
    if (definition.role !== 'step') continue;
    for (const exit of definition.exits) {
      if (!flowed.has(key(id, exit.name)) && !exposedExits.has(key(id, exit.name))) {
        error(`can leave through "${exit.name}", but nothing says where that goes`, { node: id, exit: exit.name });
      }
    }
  }

  const roots: NodeId[] = [];
  const checkEntry = (id: NodeId | undefined, what: string) => {
    if (id === undefined) return;
    if (!nodes.has(id)) error(`the ${what} node "${id}" does not exist`);
    else if (definitions.has(id) && !isStep(id)) error(`the ${what} node has to be a step, and "${id}" is a value node`, { node: id });
    else roots.push(id);
  };
  checkEntry(body.start, 'start');
  checkEntry(body.cleanup, 'cleanup');

  const reachable = new Set<NodeId>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(leaving.get(id) ?? []));
  }

  const ends = new Set<NodeId>();
  for (const [id, definition] of definitions) {
    if (definition.role !== 'step') continue;
    const exposed = definition.exits.some((exit) => exposedExits.has(key(id, exit.name)));
    if (definition.exits.length === 0 || exposed) ends.add(id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, targets] of leaving) {
      if (!ends.has(id) && targets.some((target) => ends.has(target))) {
        ends.add(id);
        grew = true;
      }
    }
  }

  for (const [id, definition] of definitions) {
    if (definition.role !== 'step') continue;
    if (!reachable.has(id)) {
      warn('nothing leads to this step, so it never runs', { node: id });
    } else if (!ends.has(id)) {
      error(scope.group ? 'no path from here ever leaves the group or finishes' : 'no path from here ever finishes', { node: id });
    }
  }

  return problems;
}

function nodesOnFlowLoops(body: Body): NodeId[] {
  const leaving = new Map<NodeId, NodeId[]>();
  for (const flow of body.flow) leaving.set(flow.from, [...(leaving.get(flow.from) ?? []), flow.to]);

  const returnsTo = (start: NodeId): boolean => {
    const seen = new Set<NodeId>();
    const queue = [...(leaving.get(start) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === start) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...(leaving.get(id) ?? []));
    }
    return false;
  };

  return body.nodes.map((node) => node.id).filter(returnsTo);
}

export function checkProcedure(procedure: Procedure, options: CheckOptions): ProcedureProblem[] {
  const problems: ProcedureProblem[] = [];
  const error = (message: string, where: Omit<ProcedureProblem, 'severity' | 'message'> = {}) =>
    problems.push({ severity: 'error', message, ...where });

  if (procedure.schema !== PROCEDURE_SCHEMA) {
    error(`this procedure is in format ${String(procedure.schema)}, and only format ${PROCEDURE_SCHEMA} can be checked`);
    return problems;
  }
  if (!procedure.id?.trim()) error('the procedure has no id');
  if (!procedure.version?.trim()) error('the procedure has no version');

  const seenGroups = new Set<string>();
  for (const group of procedure.groups) {
    if (seenGroups.has(group.id)) error(`two groups are called "${group.id}"`, { group: group.id });
    seenGroups.add(group.id);
  }

  const library = groupLibrary(procedure, options.groups);
  const scope: Scope = { catalogue: options.catalogue, library, known: options.known ?? {} };

  for (const group of procedure.groups) problems.push(...checkBody(group, { ...scope, group }));
  problems.push(...checkBody(procedure, scope));

  if (procedureErrors(problems).length > 0) return problems;

  for (const group of procedure.groups) {
    try {
      expandGroups(group, library);
    } catch (err) {
      if (!(err instanceof GroupExpansionError)) throw err;
      error(err.message, { group: group.id, node: err.node });
    }
  }
  if (procedureErrors(problems).length > 0) return problems;

  try {
    const { body } = expandGroups(procedure, library);
    const kinds = new Map(body.nodes.map((node) => [node.id, options.catalogue.get(node.kind)]));
    const modelLoops = nodesOnFlowLoops(body).filter((id) => kinds.get(id)?.spends?.includes('rounds'));
    const watched = [...kinds.values()].some((definition) => definition?.category === 'safety');
    if (modelLoops.length > 0 && !watched && !isBounded(procedure.budget ?? {})) {
      problems.push({
        severity: 'warning',
        message: 'this procedure can call the model again and again, and nothing in it watches for going in circles — add a Check Repetition or Check Stall node to the loop',
      });
    }
  } catch (err) {
    if (!(err instanceof GroupExpansionError)) throw err;
    error(err.message, { node: err.node });
  }

  return problems;
}
