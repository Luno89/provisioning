/**
 * One planning turn, after work comes back.
 *
 * ── WHY THIS RUNS AT ALL ──
 * A plan was written once, before any of it ran, and nothing revisited it. A scraper that returns a
 * table of prices might be the whole request or might be the input to an API nobody has proposed —
 * and no mechanical check can tell those apart, because the difference is what the person wanted
 * rather than what the code does.
 *
 * ── WHAT IT MAY DO ──
 * Propose work, which lands as a proposal for a human to accept exactly as any other does. It does
 * not decide the request is finished: completion is decided by running the acceptance checks and
 * reading an exit code, and inviting an opinion on it would produce one that reads like a verdict.
 *
 * ── NEVER FATAL ──
 * A leaf that did its job must not be marked failed because a planning turn could not be taken. The
 * whole activity is best-effort and reports what it did rather than throwing.
 */
import { createDatabase } from '../lib/db-interface.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import { createModelService } from '../lib/model-wiring.js';
import { resolveConfig } from '../lib/personas.js';
import { flattenPersona } from '../lib/persona-scope.js';
import { shouldReplan, summariseOutcomes, buildReplanPrompt } from '../lib/replan.js';
import { runPlanningTurn } from '../lib/planning-turn.js';
import { GiteaService } from '../services/GiteaService.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ProjectRepoService } from '../services/ProjectRepoService.js';
import { buildWebTools } from '../lib/web-tools-wiring.js';

export interface ReplanArgs {
  /** The leaf that just finished. */
  leafId: string;
}

export interface ReplanResult {
  /** How many leaves the turn proposed. Zero is a real answer: nothing further was needed. */
  proposed: number;
  /** Why no turn was taken, when none was. */
  skipped?: string;
}

export async function ReplanActivity(args: ReplanArgs): Promise<ReplanResult> {
  const db = createDatabase();
  await db.init();
  try {
    const all = await db.getLeaves();
    const leaf = all.find((l: Leaf) => l.id === args.leafId);
    if (!leaf) return { proposed: 0, skipped: 'leaf no longer exists' };

    /**
     * The budget is the ROOT's, and so is the count.
     *
     * `maxReplans` has been enforced against `usage.replans` since before anything incremented it.
     * Counting per leaf would let a wide plan replan once per branch of itself and never trip a
     * ceiling meant for the request.
     */
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

    const personas = (await db.getPersonas()).filter((p) => p.ownerId === leaf.ownerId);
    const outcomes = summariseOutcomes(all, leaf.branchId, (id) => personas.find((p) => p.id === id)?.name);
    // The original ask, not the last thing said — a replan is judged against what was wanted, and
    // the most recent message is often a correction to one leaf.
    const request = branch.messages.find((m) => m.role === 'user')?.content ?? branch.title;

    const profile = await db.getHarnessProfile(leaf.ownerId);
    const adopted = profile?.personaId ? personas.find((p) => p.id === profile.personaId) : undefined;
    const persona = adopted ? flattenPersona(adopted, personas) : null;
    const resolved = resolveConfig(profile, persona);
    const models = createModelService(db, process.env.JWT_SECRET ?? '');
    const chosen = typeof resolved.overrides.model === 'string' ? resolved.overrides.model : undefined;
    const { provider, baseUrl, apiKey } = await models.resolveBaseUrl(leaf.ownerId, chosen);

    const before = all.filter((l: Leaf) => l.branchId === leaf.branchId).length;
    const gitea = new GiteaService(
      new InfrastructureService(),
      process.env.JWT_SECRET ?? '',
      process.env.MANAGEMENT_KUBECONFIG ?? '/tmp/kubeconfig-provisioning-lunorica',
    );
    const web = await buildWebTools(db, leaf.ownerId);
    await runPlanningTurn({
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

    /**
     * Recorded whether or not anything was proposed.
     *
     * The budget counts TURNS, not proposals. A turn that decided nothing further was needed still
     * cost an inference pass, and not counting it would let a plan that keeps concluding "nothing
     * more" replan forever.
     */
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
    // A leaf that did its job is not failed because a planning turn could not be taken.
    console.warn(`[Replan] could not take a planning turn: ${(err as Error).message}`);
    return { proposed: 0, skipped: (err as Error).message };
  } finally {
    await db.close();
  }
}
