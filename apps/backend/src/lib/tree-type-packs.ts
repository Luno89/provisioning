import { withBuiltIns } from './ownership.js';
import { resolveTreeType } from './tree-types.js';
import type { PersonaPack } from '@koala/harness-types';
import type { Database } from './db-interface.js';
import type { TreeTypeSpec, TreeTypePackRole } from './tree-types.js';

export interface PackStore {
  getPersonaPacks(): Promise<PersonaPack[]>;
}

/**
 * The pack that fills a role for this kind of project.
 *
 * The binding is a database row on the tree type, not a name matched in code. Three call sites
 * used to do `packs.find((p) => p.name === 'Framer' | 'Judge' | 'Merger')`, which broke the moment
 * anyone renamed a persona — the name is a display field, and the UI lets you edit it.
 *
 * The user's own pack at that slug wins over the shipped one, which is what `withBuiltIns` does.
 */
export async function packForRole(
  store: PackStore,
  ownerId: string,
  treeType: Pick<TreeTypeSpec, 'packs'> | undefined,
  role: TreeTypePackRole,
): Promise<PersonaPack | undefined> {
  const slug = treeType?.packs?.[role];
  if (!slug) return undefined;
  return withBuiltIns(await store.getPersonaPacks(), ownerId, (p) => p.slug)
    .find((p) => p.slug === slug);
}

/**
 * The tree type a leaf belongs to, walked leaf → branch → tree → type.
 *
 * Every role lookup needs it, and each of the three call sites was doing its own version of this
 * walk (or, in the judge's and merger's case, skipping it and matching a persona name instead).
 */
export async function treeTypeForLeaf(
  db: Pick<Database, 'getBranches' | 'getTrees' | 'getTreeTypes'>,
  leaf: { branchId: string; ownerId: string },
): Promise<TreeTypeSpec | undefined> {
  const branch = (await db.getBranches()).find((b) => b.id === leaf.branchId);
  if (!branch?.treeId) return undefined;
  const tree = (await db.getTrees()).find((t) => t.id === branch.treeId);
  return resolveTreeType(db, leaf.ownerId, tree?.type);
}
