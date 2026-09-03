import { Router, type Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy, withBuiltIns } from '../lib/ownership.js';
import {
  LEAF_COLUMNS, isLeafColumn, deriveLeafStatus, budgetExceeded, aggregateUsage,
  rootLeaf, subtreeOf, blockedBy, canAddChild, childrenOf, wouldCycle, type Leaf,
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
import { acceptLeaf } from '../lib/accept-leaf.js';
import type { Database } from '../lib/db-interface.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import { WorkspaceImageService } from '../services/WorkspaceImageService.js';

export interface LeavesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
  giteaService: GiteaService;
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
    res.json(scoped.map((c) => {
      const kids = childrenOf(leaves, c.id);
      return {
        ...c,
        status: deriveLeafStatus(c.status, kids),
        childCount: kids.length,
        ...(c.parentLeafId ? {} : { usageTotal: aggregateUsage(leaves, c, Date.now()) }),
      };
    }));
  }));

  router.post('/', asyncRoute(async (req, res) => {
    try {
      const user = userOf(req);
      const { title, body, branchId, column = 'todo', parentLeafId, blocking = true, packId, projectId, budget, proposed = false, dependsOn: rawDependsOn, expects: rawExpects } = req.body ?? {};
      if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
      if (!isLeafColumn(column)) {
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

      const leaves = await ownedLeaves(user.id);
      let depth = 0;
      let resolvedBranchId = typeof branchId === 'string' && branchId ? branchId : uuidv4();
      if (parentLeafId) {
        const parent = leaves.find((c) => c.id === parentLeafId);
        if (!parent) return res.status(404).json({ error: 'Parent leaf not found' });
        if (proposed !== true) {
          const root = rootLeaf(leaves, parent);
          if (root?.budget) {
            const spent = budgetExceeded(root.budget, aggregateUsage(leaves, root, Date.now()));
            if (spent) return res.status(409).json({ error: `${spent} — this leaf's budget covers all of its sub-items` });
          }
        }

        const refusal = canAddChild(parent, childrenOf(leaves, parent.id).length);
        if (refusal) return res.status(409).json({ error: refusal });
        depth = parent.depth + 1;
        resolvedBranchId = parent.branchId;
      }

      const id = uuidv4();
      const expects = usablePaths(Array.isArray(rawExpects) ? rawExpects.map(String) : []);
      const wanted = Array.isArray(rawDependsOn) ? rawDependsOn.map(String) : [];
      const dependsOn = wanted.filter((d) => leaves.some((l) => l.id === d));
      if (wouldCycle(id, dependsOn, leaves)) {
        return res.status(409).json({ error: 'Those dependencies would form a cycle — nothing in it could ever start.' });
      }

      const now = new Date().toISOString();
      const leaf: Leaf = {
        id,
        ownerId: user.id,
        branchId: resolvedBranchId,
        ...normaliseLeafInput(req.body ?? {}),
        title: title.trim().slice(0, 200),
        column,
        status: proposed === true ? 'proposed' : 'pending',
        depth,
        blocking: blocking !== false,
        createdAt: now,
        updatedAt: now,
        ...(parentLeafId ? { parentLeafId: String(parentLeafId) } : {}),
        ...assignment,
        ...(projectId ? { projectId: String(projectId) } : {}),
        ...(dependsOn.length ? { dependsOn } : {}),
        ...(parentLeafId ? {} : { budget: budgetForNewRoot(budget) }),
      };
      await db.saveLeaf(leaf);

      if (leaf.status === 'proposed') return res.status(201).json(leaf);

      const waiting = blockedBy(leaf, leaves);
      if (waiting.length > 0) {
        return res.status(201).json({ ...leaf, waitingFor: waiting.map((w) => ({ id: w.id, title: w.title })) });
      }

      const workflowId = await temporalBridge?.startLeaf(leaf);
      if (workflowId) {
        leaf.workflowId = workflowId;
        await db.saveLeaf(leaf);
      }
      if (parentLeafId) {
        await temporalBridge?.signalLeaf(String(parentLeafId), 'addChild', {
          leafId: leaf.id,
          title: leaf.title,
          blocking: leaf.blocking,
          index: childrenOf(leaves, String(parentLeafId)).filter((c) => c.status !== 'proposed').length,
        });
      }
      res.status(201).json(leaf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  router.post('/:id/accept', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });

    const result = await acceptLeaf(
      {
        db,
        startLeaf: (l) => temporalBridge!.startLeaf(l),
        signalLeaf: (id, sig, payload) => temporalBridge!.signalLeaf(id, sig, payload),
        packOf: async (id: string | undefined) => (id ? (await db.getPersonaPacks()).find((p) => p.id === id || p.slug === id) ?? null : null),
      },
      leaf,
      leaves,
    );
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json(
      result.waitingFor.length ? { ...result.leaf, waitingFor: result.waitingFor } : result.leaf,
    );
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

  router.post('/:id/review', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });

    const trace = await db.getLeafTrace(leaf.id);
    const ranAs = leaf.packId
      ? (await db.getPersonaPacks()).find((p) => (p.id === leaf.packId || p.slug === leaf.packId)
          && (p.ownerId == null || p.ownerId === user.id))
      : undefined;
    const images = await new WorkspaceImageService(db).list(user.id);
    const sandbox = ranAs
      ? describeSandbox(images, personaWorkspace(images, { leafId: leaf.id, ownerId: user.id }, {}))
      : 'The pack this leaf ran as is no longer available, so its environment is unknown.';

    res.json({
      branchId: leaf.branchId,
      prompt: buildReviewPrompt(leaf, trace, sandbox),
      leafTitle: leaf.title,
      hasTrace: Boolean(trace?.steps.length),
    });
  }));

  router.post('/:id/retry', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    if (leaf.status !== 'failed') {
      return res.status(409).json({ error: `Only a failed leaf can be retried; this one is ${leaf.status}.` });
    }

    const reset = { ...leaf, status: 'proposed' as const, updatedAt: new Date().toISOString() };
    await db.saveLeaf(reset);
    const result = await acceptLeaf(
      {
        db,
        startLeaf: (l) => temporalBridge!.startLeaf(l),
        signalLeaf: (id, sig, payload) => temporalBridge!.signalLeaf(id, sig, payload),
        packOf: async (id: string | undefined) => (id ? (await db.getPersonaPacks()).find((p) => p.id === id || p.slug === id) ?? null : null),
      },
      reset,
      leaves.map((l) => (l.id === reset.id ? reset : l)),
    );
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result.waitingFor.length ? { ...result.leaf, waitingFor: result.waitingFor } : result.leaf);
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

  router.post('/:id/cancel', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const signalled = await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
    await db.saveLeaf({ ...leaf, status: 'cancelled', updatedAt: new Date().toISOString() });
    res.json({ success: true, workflowSignalled: signalled === true });
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
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    for (const descendant of subtreeOf(leaves, leaf.id)) {
      await temporalBridge?.signalLeaf(descendant.id, 'cancelLeaf');
      await db.deleteLeaf(descendant.id);
      await db.deleteLeafTrace(descendant.id);
    }
    await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
    await db.deleteLeaf(leaf.id);
    await db.deleteLeafTrace(leaf.id);
    res.json({ success: true, deleted: subtreeOf(leaves, leaf.id).length + 1 });
  }));

  return router;
}
