import type { PlacedNode, Procedure } from '../schema.js';

const COLUMN = 260;
const ROW = 140;
const PER_ROW = 5;

function placeIn(nodes: PlacedNode[], unplaced: ReadonlySet<string>, previous: readonly PlacedNode[] | undefined): PlacedNode[] {
  const placed = nodes.filter((node) => !unplaced.has(node.id));
  const bottom = placed.length > 0 ? Math.max(...placed.map((node) => node.position.y)) + ROW : 0;
  let index = 0;
  return nodes.map((node) => {
    if (!unplaced.has(node.id)) return node;
    const before = previous?.find((candidate) => candidate.id === node.id && candidate.kind === node.kind);
    if (before) return { ...node, position: { ...before.position } };
    const position = { x: (index % PER_ROW) * COLUMN, y: bottom + Math.floor(index / PER_ROW) * ROW };
    index += 1;
    return { ...node, position };
  });
}

export function placeUnplaced(procedure: Procedure, unplaced: readonly string[], previous?: Procedure | undefined): Procedure {
  const top = new Set(unplaced.filter((id) => !id.includes('/')));
  return {
    ...procedure,
    nodes: placeIn(procedure.nodes, top, previous?.nodes),
    groups: procedure.groups.map((group) => {
      const inside = new Set(unplaced.filter((id) => id.startsWith(`${group.id}/`)).map((id) => id.slice(group.id.length + 1)));
      const before = previous?.groups.find((candidate) => candidate.id === group.id)?.nodes;
      return inside.size > 0 ? { ...group, nodes: placeIn(group.nodes, inside, before) } : group;
    }),
  };
}
