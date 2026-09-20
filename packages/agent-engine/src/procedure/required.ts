import { expandGroups, groupLibrary } from './groups.js';
import type { GroupDefinition, PlacedNode, Procedure } from './schema.js';

export interface RequiredGrant {
  name: string;
  kind: 'tool' | 'agent';
  node: string;
  why: string;
}

const textOf = (settings: Record<string, unknown>, key: string): string =>
  (typeof settings[key] === 'string' ? settings[key] : '');

const DRIVES: Record<string, { setting: string; kind: RequiredGrant['kind'] }> = {
  'call-tool': { setting: 'tool', kind: 'tool' },
  delegate: { setting: 'agent', kind: 'agent' },
  'fan-out': { setting: 'agent', kind: 'agent' },
};

function nodesOf(
  procedure: Procedure,
  shared: readonly GroupDefinition[],
): { nodes: PlacedNode[]; origin: ReadonlyMap<string, string> } {
  try {
    const expanded = expandGroups(procedure, groupLibrary(procedure, shared));
    return { nodes: expanded.body.nodes, origin: expanded.origin };
  } catch {
    return { nodes: procedure.nodes, origin: new Map() };
  }
}

export function requiredGrants(
  procedure: Procedure | undefined,
  shared: readonly GroupDefinition[] = [],
): RequiredGrant[] {
  if (!procedure) return [];

  const { nodes, origin } = nodesOf(procedure, shared);
  const found = new Map<string, RequiredGrant>();

  for (const node of nodes) {
    const drives = DRIVES[node.kind];
    if (!drives) continue;

    const name = textOf(node.settings, drives.setting);
    if (!name || found.has(name)) continue;

    const said = textOf(node.settings, 'says');
    const id = origin.get(node.id) ?? node.id;

    found.set(name, {
      name,
      kind: drives.kind,
      node: id,
      why: said || `the "${id}" step ${drives.kind === 'agent' ? 'hands work to' : 'calls'} it`,
    });
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function missingGrants(
  procedure: Procedure | undefined,
  granted: { tools?: readonly string[] | undefined; agents?: readonly string[] | undefined },
  shared: readonly GroupDefinition[] = [],
): RequiredGrant[] {
  const tools = new Set(granted.tools ?? []);
  const agents = new Set(granted.agents ?? []);

  return requiredGrants(procedure, shared)
    .filter((required) => !(required.kind === 'tool' ? tools : agents).has(required.name));
}
