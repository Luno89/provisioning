import { expandGroups, groupLibrary } from './groups.js';
import type { GroupDefinition, PlacedNode, Procedure } from './schema.js';

const HANDS_OFF = new Set(['delegate', 'fan-out']);
const MODEL_STEPS = new Set(['choose-model', 'call-model']);

type Outlined = Pick<Procedure, 'id' | 'name' | 'describe' | 'nodes' | 'groups'>;

export interface ProcedureOutline {
  id: string;
  name: string;
  describe: string;
  handsTo: { agent: string; describe?: string | undefined; procedure?: ProcedureOutline | undefined }[];
}

const nodesOf = (procedure: Pick<Procedure, 'nodes' | 'groups'>): PlacedNode[] =>
  [...procedure.nodes, ...(procedure.groups ?? []).flatMap((group) => (group as { nodes?: PlacedNode[] }).nodes ?? [])];

export function agentsHandedTo(procedure: Pick<Procedure, 'nodes' | 'groups'>): string[] {
  const agents: string[] = [];
  for (const node of nodesOf(procedure)) {
    if (!HANDS_OFF.has(node.kind)) continue;
    const agent = node.settings.agent;
    if (typeof agent === 'string' && agent && !agents.includes(agent)) agents.push(agent);
  }
  return agents;
}

export function callsModel(procedure: Pick<Procedure, 'nodes' | 'groups' | 'wires' | 'flow' | 'start'>, shared: readonly GroupDefinition[] = []): boolean {
  let nodes: PlacedNode[];
  try {
    nodes = expandGroups(procedure, groupLibrary(procedure, shared)).body.nodes;
  } catch {
    nodes = nodesOf(procedure);
  }
  return nodes.some((node) => MODEL_STEPS.has(node.kind));
}

export function outlineProcedure(
  procedure: Outlined,
  agentOf: (agent: string) => { describe?: string | undefined; procedure?: Outlined | undefined } | undefined,
  depth = 1,
  seen: ReadonlySet<string> = new Set(),
): ProcedureOutline {
  const inside = new Set([...seen, procedure.id]);
  return {
    id: procedure.id,
    name: procedure.name,
    describe: procedure.describe,
    handsTo: agentsHandedTo(procedure).map((agent) => {
      const found = agentOf(agent);
      const theirs = depth > 0 ? found?.procedure : undefined;
      return {
        agent,
        ...(found?.describe ? { describe: found.describe } : {}),
        ...(theirs && !inside.has(theirs.id) ? { procedure: outlineProcedure(theirs, agentOf, depth - 1, inside) } : {}),
      };
    }),
  };
}

export function describeOutline(outline: ProcedureOutline, indent = '', lead = ''): string {
  const lines = [`${indent}${lead}${outline.name}: ${outline.describe}`];
  for (const hand of outline.handsTo) {
    lines.push(`${indent}  ${hand.agent}: ${hand.describe ?? 'an agent it hands work to'}`);
    if (hand.procedure) lines.push(describeOutline(hand.procedure, `${indent}    `, 'runs '));
  }
  return lines.join('\n');
}
