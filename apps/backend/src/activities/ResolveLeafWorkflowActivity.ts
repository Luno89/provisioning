import { createDatabase } from '../lib/db-interface.js';
import type { Leaf } from '../lib/leaves.js';
import { treeTypeForLeaf } from '../lib/tree-type-packs.js';
import { DEFAULT_LEAF_WORKFLOW, type LeafWorkflowSpec } from '../lib/leaf-workflow-types.js';

export interface ResolveLeafWorkflowArgs {
  leafId: string;
}

export interface ResolveLeafWorkflowResult {
  leafWorkflow: LeafWorkflowSpec;
  treeType: Record<string, unknown>;
}

export async function ResolveLeafWorkflowActivity(args: ResolveLeafWorkflowArgs): Promise<ResolveLeafWorkflowResult> {
  try {
    const db = createDatabase();
    await db.init();
    const leaf = (await db.getLeaves()).find((l: Leaf) => l.id === args.leafId);
    if (!leaf) return { leafWorkflow: DEFAULT_LEAF_WORKFLOW, treeType: {} };

    const treeType = await treeTypeForLeaf(db, leaf);
    if (!treeType) return { leafWorkflow: DEFAULT_LEAF_WORKFLOW, treeType: {} };

    return {
      leafWorkflow: treeType.leafWorkflow ?? DEFAULT_LEAF_WORKFLOW,
      treeType: treeType as unknown as Record<string, unknown>,
    };
  } catch (err) {
    console.warn(`[ResolveLeafWorkflow] falling back to the default sequence: ${(err as Error).message}`);
    return { leafWorkflow: DEFAULT_LEAF_WORKFLOW, treeType: {} };
  }
}
