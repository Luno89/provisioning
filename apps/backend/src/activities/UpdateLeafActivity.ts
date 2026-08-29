import { createDatabase } from '../lib/db-interface.js';
import type { Leaf, LeafAttempt, LeafColumn, LeafStatus } from '../lib/leaves.js';

export interface UpdateLeafArgs {
  leafId: string;
  status?: LeafStatus;
  column?: LeafColumn;
  workflowId?: string;
  attempts?: LeafAttempt[];
  usage?: { tokens?: number; workspaces?: number; replans?: number };
}

export async function UpdateLeafActivity(args: UpdateLeafArgs): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const leaves = await db.getLeaves();
    const leaf = leaves.find((c: Leaf) => c.id === args.leafId);
    if (!leaf) return;

    await db.saveLeaf({
      ...leaf,
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.column !== undefined ? { column: args.column } : {}),
      ...(args.workflowId !== undefined ? { workflowId: args.workflowId } : {}),
      ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
      ...(args.usage
        ? {
            usage: {
              tokens: (leaf.usage?.tokens ?? 0) + (args.usage.tokens ?? 0),
              workspaces: (leaf.usage?.workspaces ?? 0) + (args.usage.workspaces ?? 0),
              replans: (leaf.usage?.replans ?? 0) + (args.usage.replans ?? 0),
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    });
  } finally {
    await db.close();
  }
}
