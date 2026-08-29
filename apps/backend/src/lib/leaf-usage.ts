import type { Database } from './db-interface.js';
import type { Leaf } from './leaves.js';

export async function countWorkspace(db: Database, leafId: string): Promise<void> {
  try {
    const leaf = (await db.getLeaves()).find((l: Leaf) => l.id === leafId);
    if (!leaf) return;

    await db.saveLeaf({
      ...leaf,
      usage: { ...(leaf.usage ?? {}), workspaces: (leaf.usage?.workspaces ?? 0) + 1 },
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[leaf-usage] could not count a workspace for ${leafId}: ${err?.message ?? err}`);
  }
}
