import { createDatabase } from '../lib/db-interface.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import { createModelService } from '../lib/model-wiring.js';
import { resolvePrompt } from '../lib/personas.js';
import { flattenPersona } from '../lib/persona-scope.js';
import { shouldReplan, summariseOutcomes, buildReplanPrompt } from '../lib/replan.js';
import { runPlanningTurn } from '../lib/planning-turn.js';
import { packForRole, treeTypeForLeaf } from '../lib/tree-type-packs.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';
import { withBuiltIns } from '../lib/ownership.js';
import { ToolService } from '../services/ToolService.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { requirePrompt } from '../lib/pack-defaults.js';

export interface ReplanArgs {
  leafId: string;
}

export interface ReplanResult {
  proposed: number;
  skipped?: string;
}

export async function ReplanActivity(args: ReplanArgs): Promise<ReplanResult> {
  const db = createDatabase();
  await db.init();
  try {
    const all = await db.getLeaves();
    const leaf = all.find((l: Leaf) => l.id === args.leafId);
    if (!leaf) return { proposed: 0, skipped: 'leaf no longer exists' };

    const siblings = all.filter((l: Leaf) => l.branchId === leaf.branchId);
    const used = siblings.reduce((n, l) => n + (l.usage?.replans ?? 0), 0);
    const budget = siblings.find((l) => l.budget)?.budget;

    const verdict = shouldReplan(leaf, all, budget, used);
    if (!verdict.replan) {
      console.log(`[Replan] skip for ${args.leafId.slice(0, 8)}: ${verdict.reason}`);
      return { proposed: 0, ...(verdict.reason ? { skipped: verdict.reason } : {}) };
    }

    const branch = (await db.getBranches()).find((b: Branch) => b.id === leaf.branchId);
    if (!branch) return { proposed: 0, skipped: 'branch is gone' };

    const personas = withBuiltIns(await db.getPersonas(), leaf.ownerId, (p) => p.name);
    const outcomes = summariseOutcomes(all, leaf.branchId, (id) => personas.find((p) => p.id === id)?.name);
    const request = branch.messages.find((m) => m.role === 'user')?.content ?? branch.title;

    const profile = await db.getHarnessProfile(leaf.ownerId);
    // Replanning is planning: it uses the planner this tree type names. It used to take whatever
    // pack the account happened to default to, which was usually a chat or worker pack.
    const treeType = await treeTypeForLeaf(db, leaf);
    const pack = await packForRole(db, leaf.ownerId, treeType, 'planner') ?? null;
    const adopted = pack ? personas.find((p) => p.id === pack.personaId) : undefined;
    const persona = adopted ? flattenPersona(adopted, personas) : null;
    const systemPrompt = resolvePrompt(persona);
    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    // The engine is the pack's; nothing layered can name one any more.
    const chosen = undefined;
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(leaf.ownerId, chosen, pack?.model?.endpointId);

    const before = all.filter((l: Leaf) => l.branchId === leaf.branchId).length;
    const gitea = new GiteaService(
      new InfrastructureService(),
      process.env.JWT_SECRET ?? '',
      process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
    );
    const web = await buildWebTools(db, leaf.ownerId);
    await runPlanningTurn({
      toolRows: await new ToolService(db).list(leaf.ownerId),
      images: await new WorkspaceImageService(db).list(leaf.ownerId),
      promptConfig: pack?.prompt ?? await requirePrompt(db),
      ...(pack?.budget ? { budget: pack.budget } : {}),
      ...(pack?.sampling ? { sampling: pack.sampling } : {}),
      ...(pack?.tools?.length ? { grantedTools: pack.tools } : {}),
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model: provider.model,
      ...(provider.kind ? { kind: provider.kind } : {}),
      prompt: buildReplanPrompt(request, outcomes),
      ...(persona ? { persona } : {}),
      ...(profile ? { profile } : {}),
      tools: {
        db,
        userId: leaf.ownerId,
        branchId: leaf.branchId,
        webSearch: (query) => web.search(query),
        fetchWebPage: (url) => web.fetchPage(url),
        projects: new ProjectRepoService(db, gitea, process.env.JWT_SECRET ?? ''),
      },
    });

    const after = (await db.getLeaves()).filter((l: Leaf) => l.branchId === leaf.branchId).length;
    const proposed = Math.max(0, after - before);

    const latest = (await db.getLeaves()).find((l: Leaf) => l.id === args.leafId);
    if (latest) {
      await db.saveLeaf({
        ...latest,
        usage: { ...(latest.usage ?? {}), replans: (latest.usage?.replans ?? 0) + 1 },
        updatedAt: new Date().toISOString(),
      });
    }

    console.log(`[Replan] ${args.leafId.slice(0, 8)} proposed ${proposed} leaf(s)`);
    return { proposed };
  } catch (err) {
    console.warn(`[Replan] could not take a planning turn: ${(err as Error).message}`);
    return { proposed: 0, skipped: (err as Error).message };
  } finally {
    await db.close();
  }
}
