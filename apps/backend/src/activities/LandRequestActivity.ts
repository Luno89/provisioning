/**
 * The sweep that runs when every leaf of a request has stopped.
 *
 * ── WHAT IT IS FOR ──
 * A leaf merges itself the moment it verifies, and for a chain that is always enough: each leaf
 * branches from the previous one's output, so every merge fast-forwards and the default branch
 * stays consistent the whole way through. Parallel leaves are the gap. Two branches cut
 * independently can touch the same file, and the loser's merge is abandoned rather than forced —
 * correctly, because resolving it would mean guessing at work nothing can check. That leaves
 * verified work intact on a branch nobody looks at, which is the exact failure that made every
 * repository read as empty in the first place, one level further in.
 *
 * ── WHY IT IS NOT THE ONLY MERGE ──
 * Landing everything at the end and nothing before it would mean a request shows no progress until
 * it completes, and one permanently failed leaf would mean nothing lands at all. Per-leaf merging
 * keeps the work visible; this catches what per-leaf merging could not.
 *
 * ── WHY A PULL REQUEST ──
 * By the time this runs, every leaf's pod is gone. Merging with git would mean creating a workspace
 * to run three commands; `GiteaService.mergeBranch` does it over the API and leaves a record of
 * what landed. See that method.
 */
import { createDatabase } from '../lib/db-interface.js';
import { requestFinished, unlandedWork, type Leaf } from '../lib/leaves.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import type { ProjectMetadata } from '../lib/types.js';

export interface LandRequestArgs {
  /**
   * Any leaf of the request. The request is derived from it rather than passed in.
   *
   * `LeafWorkflow` does not carry a branchId, and adding one would change workflow arguments that
   * already exist in Temporal history — a versioning problem in exchange for a lookup this activity
   * is doing anyway.
   */
  leafId: string;
}

export interface LandRequestResult {
  /** False when the request is still working — the common case, and not an error. */
  swept: boolean;
  landed: string[];
  /** Leaves whose work needs a human: a conflict, or a merge the server refused. */
  stuck: string[];
}

export async function LandRequestActivity(args: LandRequestArgs): Promise<LandRequestResult> {
  const db = createDatabase();
  await db.init();
  try {
    const all = await db.getLeaves();
    const self = all.find((l: Leaf) => l.id === args.leafId);
    if (!self) return { swept: false, landed: [], stuck: [] };
    const leaves = all.filter((l: Leaf) => l.branchId === self.branchId);
    // Nothing to do until the whole request has settled. Checked here rather than in the workflow
    // so the rule lives with the rest of the landing logic.
    if (leaves.length === 0 || !requestFinished(leaves)) return { swept: false, landed: [], stuck: [] };

    const outstanding = unlandedWork(leaves);
    if (outstanding.length === 0) return { swept: true, landed: [], stuck: [] };

    const projects = await db.getProjects();
    const gitea = new GiteaService(
      new InfrastructureService(),
      process.env.JWT_SECRET ?? '',
      process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
    );

    const landed: string[] = [];
    const stuck: string[] = [];

    for (const leaf of outstanding) {
      const project = projects.find((p: ProjectMetadata) => p.id === leaf.projectId);
      if (!project?.giteaOwner || !project.giteaRepo) {
        stuck.push(leaf.id);
        continue;
      }

      const outcome = await gitea
        .mergeBranch(project.giteaOwner, project.giteaRepo, leaf.outputBranch!, project.defaultBranch || 'main')
        .catch(() => 'failed' as const);

      // `nothing` means everything on the branch is already on the base — a chain whose tip landed
      // and carried this leaf's commits with it. That is landed, not stuck.
      if (outcome === 'merged' || outcome === 'nothing') {
        landed.push(leaf.id);
        // Re-read: the leaf may have been written since this activity started, and a full-object
        // save from stale state is how fields get silently reverted.
        const latest = (await db.getLeaves()).find((l: Leaf) => l.id === leaf.id);
        if (latest) await db.saveLeaf({ ...latest, merged: true, updatedAt: new Date().toISOString() });
      } else {
        stuck.push(leaf.id);
        console.warn(`[LandRequest] "${leaf.title}" could not be landed (${outcome}); its work is on ${leaf.outputBranch}`);
      }
    }

    return { swept: true, landed, stuck };
  } finally {
    await db.close();
  }
}
