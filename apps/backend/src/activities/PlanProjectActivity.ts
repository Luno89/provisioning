import { createDatabase } from '../lib/db-interface.js';
import type { Branch } from '../lib/leaves.js';
import { createModelService } from '../lib/model-wiring.js';
import { resolvePrompt } from '../lib/personas.js';
import { flattenPersona } from '../lib/persona-scope.js';
import { runPlanningTurn } from '../lib/planning-turn.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { withBuiltIns } from '../lib/ownership.js';
import { ToolService } from '../services/ToolService.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { packForRole } from '../lib/tree-type-packs.js';
import { resolveTreeType } from '../lib/tree-types.js';
import { buildPlanningBrief } from '../lib/planning-brief.js';

export interface PlanProjectArgs {
  treeId: string;
  branchId: string;
}

export interface PlanProjectResult {
  proposed: number;
  skipped?: string;
}

/**
 * The first planning turn for a newly accepted project.
 *
 * This replaces the "framing leaf" the accept route used to create and immediately run. That leaf
 * went through `ExecuteLeafActivity`, whose agent loop can only dispatch `sandbox`-surface tools —
 * so it could never call `propose_leaf` and never produced a plan. It was also handed the tree
 * type's `validationRecipe` as its own acceptance contract, which told a planner to make the
 * product build. Planning is a planning turn; it gets no sandbox and no validation contract.
 */
export async function PlanProjectActivity(args: PlanProjectArgs): Promise<PlanProjectResult> {
  const db = createDatabase();
  await db.init();
  try {
    const tree = (await db.getTrees()).find((t) => t.id === args.treeId);
    if (!tree) return { proposed: 0, skipped: 'tree no longer exists' };

    const branch = (await db.getBranches()).find((b: Branch) => b.id === args.branchId);
    if (!branch) return { proposed: 0, skipped: 'branch is gone' };

    const ownerId = tree.ownerId;
    const treeType = await resolveTreeType(db, ownerId, tree.type);
    const pack = await packForRole(db, ownerId, treeType, 'planner');
    if (!pack) {
      return { proposed: 0, skipped: `tree type "${tree.type}" names no planner pack` };
    }

    const personas = withBuiltIns(await db.getPersonas(), ownerId, (p) => p.name);
    const assigned = personas.find((p) => p.id === pack.personaId);
    const persona = assigned ? flattenPersona(assigned, personas) : null;

    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(
      ownerId, undefined, pack.model?.endpointId,
    );

    const gitea = new GiteaService(
      new InfrastructureService(),
      process.env.JWT_SECRET ?? '',
      process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
    );
    const web = await buildWebTools(db, ownerId);

    const before = (await db.getLeaves()).filter((l) => l.branchId === branch.id).length;

    await runPlanningTurn({
      toolRows: await new ToolService(db).list(ownerId),
      images: await new WorkspaceImageService(db).list(ownerId),
      promptConfig: pack.prompt,
      budget: pack.budget,
      sampling: pack.sampling,
      grantedTools: pack.tools,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model: provider.model,
      ...(provider.kind ? { kind: provider.kind } : {}),
      prompt: buildPlanningBrief(tree, treeType),
      ...(persona ? { persona } : {}),
      research: {
        webSearch: (query) => web.search(query),
        fetchWebPage: (url) => web.fetchPage(url),
      },
      tools: {
        db,
        userId: ownerId,
        branchId: branch.id,
        webSearch: (query) => web.search(query),
        fetchWebPage: (url) => web.fetchPage(url),
        projects: new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? ''),
      },
    });

    const after = (await db.getLeaves()).filter((l) => l.branchId === branch.id).length;
    const proposed = Math.max(0, after - before);
    console.log(`[PlanProject] ${args.treeId.slice(0, 8)} proposed ${proposed} leaf(s)`);
    return { proposed };
  } catch (err) {
    console.warn(`[PlanProject] could not plan: ${(err as Error).message}`);
    return { proposed: 0, skipped: (err as Error).message };
  } finally {
    await db.close();
  }
}
