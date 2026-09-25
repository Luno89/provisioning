import { Router, type Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy, withBuiltIns } from '../lib/ownership.js';
import {
  LEAF_COLUMNS, isLeafColumn, deriveLeafStatus, budgetExceeded, aggregateUsage,
  rootLeaf, subtreeOf, blockedBy, canAddChild, childrenOf, wouldCycle, settleClaim, runsOnEngine, isFrozenLeaf, FROZEN_LEAF, type Leaf,
} from '../lib/leaves.js';
import { budgetForNewRoot } from '../lib/budget-policy.js';
import { buildReviewPrompt } from '../lib/failure-review.js';
import { canRecheck, recheckVerdict, statusAfterRecheck } from '../lib/leaf-recheck.js';
import { describeSandbox } from '../lib/workspace-spec.js';
import { droppedCount } from '../lib/leaf-trace.js';
import { normaliseLeafInput } from '../lib/leaf-input.js';
import { personaWorkspace, canRunLeaf } from '../lib/persona-scope.js';
import { usablePaths } from '../lib/leaf-artifacts.js';
import type { GiteaService } from '../services/GiteaService.js';
import type { Database } from '../lib/db-interface.js';
import type { GroveRunService } from '../services/GroveRunService.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';
import { treeTypeForLeaf, packForRole } from '../lib/tree-type-packs.js';
import { TREE_TYPE_PACK_ROLES } from '../lib/tree-types.js';
import { DEFAULT_POLICY, review, type AutoAcceptPolicy } from '../lib/auto-accept.js';
import { DEFAULT_LEAF_WORKFLOW } from '../lib/leaf-workflow-types.js';

export interface LeavesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
  giteaService: GiteaService;
  runs?: Pick<GroveRunService, 'retryLeaf'> | undefined;
  deletion: Pick<GroveDeletionService, 'deleteLeaf'>;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function leavesRouter(deps: LeavesRouterDeps): Router {
  const { db, temporalBridge, giteaService } = deps;
  const router = Router();

  const ownedLeaves = async (userId: string): Promise<Leaf[]> =>
    ownedBy(await db.getLeaves(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const leaves = await ownedLeaves(userOf(req).id);
    const branchId = req.query.branchId;
    const scoped = typeof branchId === 'string' ? leaves.filter((c) => c.branchId === branchId) : leaves;
    const branches = await db.getBranches();
    res.json(scoped.map((c) => {
      const kids = childrenOf(leaves, c.id);
      return {
        ...c,
        frozen: isFrozenLeaf(c, branches, leaves),
        status: deriveLeafStatus(c.status, kids),
        childCount: kids.length,
        ...(c.parentLeafId ? {} : { usageTotal: aggregateUsage(leaves, c, Date.now()) }),
      };
    }));
  }));

  router.patch('/:id', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });

    const { column, title, body, packId, maxTokens } = req.body ?? {};
    if (column !== undefined && !isLeafColumn(column)) {
      return res.status(400).json({ error: `column must be one of: ${LEAF_COLUMNS.join(', ')}` });
    }

    // Who runs this leaf. packId only — Leaf declares no other field for this.
    let assignment: Partial<Leaf> = {};
    if (packId !== undefined) {
      const packs = withBuiltIns(await db.getPersonaPacks(), user.id, (p) => p.slug);
      const pack = packs.find((p) => p.id === packId || p.slug === packId);
      if (!pack) return res.status(400).json({ error: 'No pack with that id.' });
      if (!canRunLeaf(pack)) {
        return res.status(400).json({
          error: `"${pack.name}" has no sandbox, so it cannot carry out work. It plans or chats instead.`,
        });
      }
      assignment = { packId: pack.id };
    }

    let budgetPatch: Partial<Leaf> = {};
    if (maxTokens !== undefined) {
      if (leaf.parentLeafId) {
        return res.status(400).json({ error: 'Only the first leaf of a request carries its budget' });
      }
      const wanted = Number(maxTokens);
      if (!Number.isFinite(wanted) || wanted <= 0) {
        return res.status(400).json({ error: 'maxTokens must be a positive number' });
      }
      budgetPatch = { budget: { ...(leaf.budget ?? {}), maxTokens: Math.round(wanted) } };
    }
    if (isFrozenLeaf(leaf, await db.getBranches(), leaves)) return res.status(409).json({ error: FROZEN_LEAF });
    if (column && childrenOf(leaves, leaf.id).length > 0) {
      return res.status(409).json({ error: 'This leaf\'s state follows its sub-items — move those instead' });
    }
    const updated: Leaf = {
      ...leaf,
      ...(column ? { column } : {}),
      ...(title ? { title: String(title).trim() } : {}),
      ...(body !== undefined ? { body: String(body) } : {}),
      ...assignment,
      ...budgetPatch,
      updatedAt: new Date().toISOString(),
    };
    await db.saveLeaf(updated);
    if (column) await temporalBridge?.signalLeaf(leaf.id, 'moveLeaf', column);
    res.json(updated);
  }));

  router.post('/:id/retry', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    if (leaf.status !== 'failed') {
      return res.status(409).json({ error: `Only a failed leaf can be retried; this one is ${leaf.status}.` });
    }
    if (isFrozenLeaf(leaf, await db.getBranches(), leaves)) return res.status(409).json({ error: FROZEN_LEAF });
    if (!deps.runs) return res.status(503).json({ error: 'Engine runs are not wired here.' });
    const retried = await deps.runs.retryLeaf(user.id, leaf);
    if (!retried.ok) return res.status(retried.status).json({ error: retried.error });
    return res.json(retried.value);
  }));

  router.post('/:id/recheck', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    if (!canRecheck(leaf)) {
      return res.json({ outcome: 'not-applicable', reason: 'Only a failed leaf that pushed a branch can be rechecked.' });
    }

    const project = leaf.projectId ? (await db.getProjects()).find((p: any) => p.id === leaf.projectId) : undefined;
    if (!project) {
      return res.json({ outcome: 'not-applicable', reason: 'This leaf is not attached to a repository.' });
    }

    let facts = { exists: false, found: [] as string[], missing: leaf.expects ?? [] };
    try {
      facts = await giteaService.inspectBranch(
        (project as any).giteaOwner, (project as any).giteaRepo, leaf.outputBranch!, leaf.expects ?? [],
      );
      if (!(project as any).giteaOwner || !(project as any).giteaRepo) {
        return res.status(502).json({ error: 'This project has no Gitea repository recorded, so there is nothing to look at.' });
      }
    } catch (err: any) {
      return res.status(502).json({ error: `Could not read the repository: ${String(err?.message ?? err).slice(0, 200)}` });
    }

    const verdict = recheckVerdict(leaf, facts);
    const update = statusAfterRecheck(verdict);
    if (update) {
      await db.saveLeaf({ ...leaf, ...update, updatedAt: new Date().toISOString() });
    }
    res.json({ ...verdict, changed: Boolean(update), branch: leaf.outputBranch, found: facts.found, missing: facts.missing });
  }));

  router.post('/:id/settle', asyncRoute(async (req, res) => {
    const leaf = (await ownedLeaves(userOf(req).id)).find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const verdict = req.body?.verdict;
    if (verdict !== 'verified' && verdict !== 'failed') return res.status(400).json({ error: "verdict is 'verified' or 'failed'" });
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : undefined;

    const outcome = settleClaim(leaf, { verdict, note, by: 'person', at: new Date().toISOString() });
    if ('problem' in outcome) return res.status(409).json({ error: outcome.problem });
    await db.saveLeaf(outcome.leaf);
    res.json(outcome.leaf);
  }));

  router.post('/:id/cancel', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const signalled = await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
    await db.saveLeaf({ ...leaf, status: 'cancelled', updatedAt: new Date().toISOString() });
    res.json({ success: true, workflowSignalled: signalled === true });
  }));

  router.get('/:id/explain', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });

    const treeType = await treeTypeForLeaf(db, leaf);

    const roles: Partial<Record<typeof TREE_TYPE_PACK_ROLES[number], { id: string; name: string; slug: string }>> = {};
    for (const role of TREE_TYPE_PACK_ROLES) {
      const pack = await packForRole(db, user.id, treeType, role);
      if (pack) roles[role] = { id: pack.id, name: pack.name, slug: pack.slug };
    }

    const branch = (await db.getBranches()).find((b) => b.id === leaf.branchId);
    const policy: AutoAcceptPolicy = {
      ...DEFAULT_POLICY,
      ...(treeType?.autoAccept ?? {}),
      enabled: (branch?.autoAccept ?? treeType?.autoAccept?.enabled) === true,
    };
    const siblings = (await ownedLeaves(user.id)).filter((l) => l.branchId === leaf.branchId && l.id !== leaf.id);
    const verdict = review(leaf, siblings, policy);

    res.json({
      leaf: { id: leaf.id, title: leaf.title, status: leaf.status },
      treeType: treeType ? { id: treeType.id, label: treeType.label, summary: treeType.summary } : undefined,
      roles,
      validationRecipe: treeType?.validationRecipe,
      leafWorkflow: treeType?.leafWorkflow ?? DEFAULT_LEAF_WORKFLOW,
      autoAccept: { policy, verdict },
    });
  }));

  router.get('/:id/trace', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const trace = await db.getLeafTrace(leaf.id);
    if (!trace) {
      return res.json({ steps: [], totalSteps: 0, tokensUsed: 0, missing: true });
    }
    res.json({ ...trace, dropped: droppedCount(trace) });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const outcome = await deps.deletion.deleteLeaf(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ success: true, stoppedRun: outcome.value.stoppedRun, deleted: outcome.value.scope });
  }));

  return router;
}
