import { createDatabase } from '../lib/db-interface.js';
import { requestFinished, unlandedWork, type Leaf } from '../lib/leaves.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import type { ProjectMetadata } from '../lib/types.js';

export interface LandRequestArgs {
  leafId: string;
}

export interface LandRequestResult {
  swept: boolean;
  landed: string[];
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

      if (outcome === 'merged' || outcome === 'nothing') {
        landed.push(leaf.id);
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
