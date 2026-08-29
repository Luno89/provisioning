import type { Leaf } from './leaves.js';
import type { Persona } from '@koala/harness-types';

export interface BoardLeaf {
  title: string;
  body: string;
  dependsOn: string[];
  persona: string | null;
  parent: string | null;
}

export function serialiseBoard(leaves: Leaf[], personas: Persona[] = []): BoardLeaf[] {
  const titleById = new Map(leaves.map((l) => [l.id, l.title]));
  const personaById = new Map(personas.map((p) => [p.id, p.name]));

  return [...leaves]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((leaf) => ({
      title: leaf.title,
      body: leaf.body ?? '',
      dependsOn: (leaf.dependsOn ?? [])
        .map((id) => titleById.get(id))
        .filter((t): t is string => t !== undefined),
      persona: (leaf.packId && personaById.get(leaf.packId)) || null,
      parent: (leaf.parentLeafId && titleById.get(leaf.parentLeafId)) || null,
    }));
}

export const BOARD_PATH = 'leaves.json';

export function boardFile(leaves: Leaf[], personas: Persona[] = []): { path: string; content: string } {
  return { path: BOARD_PATH, content: `${JSON.stringify(serialiseBoard(leaves, personas), null, 2)}\n` };
}
