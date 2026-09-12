import type { RunOutcome } from './events.js';
import type { RunBudget } from './run.js';
import { compileExpr, ExprError } from './expr.js';

export type NodeId = string;

export interface Edge {
  to: NodeId;
  when?: string | undefined;
}

interface NodeBase {
  id: NodeId;
  next?: Edge[] | undefined;
}

export interface ModelNode extends NodeBase {
  kind: 'model';
  tools?: 'granted' | 'none' | undefined;
  toolChoice?: 'none' | undefined;
  think?: boolean | undefined;
  maxTokens?: number | undefined;
  reasoningEffort?: string | undefined;
}

export interface ToolNode extends NodeBase {
  kind: 'tool';
  tool: string;
  args?: Record<string, unknown> | undefined;
}

export interface AgentNode extends NodeBase {
  kind: 'agent';
  agent: string;
  inputs?: Record<string, unknown> | undefined;
  as?: string | undefined;
}

export interface BranchNode extends NodeBase {
  kind: 'branch';
}

export interface TransformNode extends NodeBase {
  kind: 'transform';
  transform: string;
  as?: string | undefined;
}

export interface FanOutNode extends NodeBase {
  kind: 'fanout';
  over: string;
  agent: string;
  join: NodeId;
  as?: string | undefined;
  maxParallel?: number | undefined;
}

export interface MergeNode extends NodeBase {
  kind: 'merge';
  strategy?: string | undefined;
}

export interface TerminalNode extends NodeBase {
  kind: 'terminal';
  outcome: RunOutcome;
  reason?: string | undefined;
}

export type LoopNode =
  | ModelNode
  | ToolNode
  | AgentNode
  | BranchNode
  | TransformNode
  | FanOutNode
  | MergeNode
  | TerminalNode;

export interface LoopGraph {
  id: string;
  version: string;
  entry: NodeId;
  nodes: LoopNode[];
  budget?: RunBudget | undefined;
  requires?: {
    terminal?: boolean | undefined;
    egress?: boolean | undefined;
    workspace?: boolean | undefined;
  } | undefined;
}

export interface GraphProblem {
  severity: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

const edgesOf = (node: LoopNode): Edge[] => node.next ?? [];

const isBounded = (budget: RunBudget | undefined): boolean =>
  Boolean(budget && (
    budget.maxRounds !== undefined
    || budget.maxTokens !== undefined
    || budget.maxWallClockMs !== undefined
    || budget.maxToolCalls !== undefined
  ));

export function nodeMap(graph: LoopGraph): Map<NodeId, LoopNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function successors(node: LoopNode): NodeId[] {
  const ids = edgesOf(node).map((edge) => edge.to);
  if (node.kind === 'fanout') ids.push(node.join);
  return ids;
}

function hasCycle(graph: LoopGraph): boolean {
  const map = nodeMap(graph);
  const seen = new Set<NodeId>();
  const stack = new Set<NodeId>();

  const walk = (id: NodeId): boolean => {
    if (stack.has(id)) return true;
    if (seen.has(id)) return false;
    const node = map.get(id);
    if (!node) return false;
    seen.add(id);
    stack.add(id);
    for (const next of successors(node)) {
      if (walk(next)) return true;
    }
    stack.delete(id);
    return false;
  };

  return walk(graph.entry);
}

function reachesTerminal(graph: LoopGraph): Set<NodeId> {
  const good = new Set<NodeId>();

  for (const node of graph.nodes) {
    if (node.kind === 'terminal') good.add(node.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (good.has(node.id)) continue;
      if (successors(node).some((id) => good.has(id))) {
        good.add(node.id);
        changed = true;
      }
    }
  }

  return good;
}

function reachableFromEntry(graph: LoopGraph): Set<NodeId> {
  const map = nodeMap(graph);
  const seen = new Set<NodeId>();
  const queue: NodeId[] = [graph.entry];

  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = map.get(id);
    if (node) queue.push(...successors(node));
  }

  return seen;
}

export function validateGraph(
  graph: LoopGraph,
  known: { tools?: Set<string>; agents?: Set<string>; transforms?: Set<string> } = {},
): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const map = nodeMap(graph);

  if (graph.nodes.length === 0) {
    problems.push({ severity: 'error', message: 'a loop needs at least one node' });
    return problems;
  }

  const seenIds = new Set<NodeId>();
  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) {
      problems.push({ severity: 'error', nodeId: node.id, message: `two nodes share the id "${node.id}"` });
    }
    seenIds.add(node.id);
  }

  if (!map.has(graph.entry)) {
    problems.push({ severity: 'error', message: `the entry node "${graph.entry}" does not exist` });
  }

  for (const node of graph.nodes) {
    for (const edge of edgesOf(node)) {
      if (!map.has(edge.to)) {
        problems.push({ severity: 'error', nodeId: node.id, message: `points at "${edge.to}", which does not exist` });
      }
      if (edge.when) {
        try {
          compileExpr(edge.when);
        } catch (err) {
          const detail = err instanceof ExprError ? err.message : String(err);
          problems.push({ severity: 'error', nodeId: node.id, message: `condition "${edge.when}" does not parse: ${detail}` });
        }
      }
    }

    if (node.kind === 'fanout') {
      if (!map.has(node.join)) {
        problems.push({ severity: 'error', nodeId: node.id, message: `joins at "${node.join}", which does not exist` });
      }
      if (known.agents && !known.agents.has(node.agent)) {
        problems.push({ severity: 'error', nodeId: node.id, message: `fans out to agent "${node.agent}", which is not available here` });
      }
    }

    if (node.kind === 'agent' && known.agents && !known.agents.has(node.agent)) {
      problems.push({ severity: 'error', nodeId: node.id, message: `calls agent "${node.agent}", which is not available here` });
    }

    if (node.kind === 'tool' && known.tools && !known.tools.has(node.tool)) {
      problems.push({ severity: 'error', nodeId: node.id, message: `calls tool "${node.tool}", which is not available here` });
    }

    if (node.kind === 'transform' && known.transforms && !known.transforms.has(node.transform)) {
      problems.push({ severity: 'error', nodeId: node.id, message: `uses transform "${node.transform}", which does not exist` });
    }

    if (node.kind !== 'terminal' && edgesOf(node).length === 0 && node.kind !== 'fanout') {
      problems.push({ severity: 'error', nodeId: node.id, message: 'has nowhere to go and is not a terminal' });
    }
  }

  const settles = reachesTerminal(graph);
  const live = reachableFromEntry(graph);
  for (const node of graph.nodes) {
    if (live.has(node.id) && !settles.has(node.id)) {
      problems.push({ severity: 'error', nodeId: node.id, message: 'no path from here ever reaches a terminal' });
    }
    if (!live.has(node.id)) {
      problems.push({ severity: 'warning', nodeId: node.id, message: 'nothing can reach this node' });
    }
  }

  if (hasCycle(graph) && !isBounded(graph.budget)) {
    problems.push({
      severity: 'error',
      message: 'this loop can cycle forever — give it a budget (rounds, tokens, tool calls or wall clock)',
    });
  }

  return problems;
}

export const graphErrors = (problems: GraphProblem[]): GraphProblem[] =>
  problems.filter((problem) => problem.severity === 'error');
