import { Router, type Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
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
import { personaWorkspace } from '../lib/persona-scope.js';
import { usablePaths } from '../lib/leaf-artifacts.js';
import type { GiteaService } from '../services/GiteaService.js';
import { acceptLeaf } from '../lib/accept-leaf.js';
import type { Database } from '../lib/db-interface.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';

/**
 * The board: leaves, and everything done to them.
 *
 * ── THE LARGEST SINGLE DOMAIN LEFT IN index.ts ──
 * Ten routes over 455 lines — propose, accept, revise, review, retry, recheck, cancel, delete, and
 * the trace. It reaches for `lib/leaves.ts` for every decision it makes: 38 pure total functions
 * over plain data, with no I/O, which is why this router is mostly reading a record, asking
 * `lib/leaves.ts` a question, and writing the answer back.
 *
 * ── STILL NOT A SERVICE ──
 * Same reasoning as trees and branches (B5). The one thing that genuinely wanted a home was the
 * `acceptLeaf` sequence — starting a workflow, signalling a parent, updating the board — and it
 * already had one in `lib/accept-leaf.ts`, shared with the automatic path. Its own header states
 * the rule: what differs between the manual and automatic paths is the DECISION to accept, never
 * what accepting does.
 */
export interface LeavesRouterDeps {
  db: Database;
  temporalBridge: TemporalBridge;
  /** Used by the trace route to resolve a leaf's pushed branch to a browsable URL. */
  giteaService: GiteaService;
}

/** The `:id` from the path, narrowed once — Express types `req.params` loosely inside asyncRoute. */
const idOf = (req: Request): string => String(req.params.id ?? '');

/** The user `requireAuth` put on the request. */
const userOf = (req: Request): { id: string; email: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; email: string; isAdmin?: boolean } }).user;

export function leavesRouter(deps: LeavesRouterDeps): Router {
  const { db, temporalBridge, giteaService } = deps;
  const router = Router();

  /**
   * Leaves are the durable unit of work, not a view over one: each leaf in an active column will map
   * to a Temporal workflow. Phase B is humans moving leaves; the workflow binding arrives with the
   * personas that act on them.
   */
  const ownedLeaves = async (userId: string): Promise<Leaf[]> =>
    ownedBy(await db.getLeaves(), userId);

  router.get('/', asyncRoute(async (req, res) => {
    const leaves = await ownedLeaves(userOf(req).id);
    // Scoped to a request: a leaf belongs to the ask that produced it, not to a long-lived board.
    const branchId = req.query.branchId;
    const scoped = typeof branchId === 'string' ? leaves.filter((c) => c.branchId === branchId) : leaves;
    // Effective status is DERIVED for a leaf with children — a parent dragged around while its
    // children are mid-flight would otherwise report something the workflow does not agree with.
    res.json(scoped.map((c) => {
      const kids = childrenOf(leaves, c.id);
      return {
        ...c,
        status: deriveLeafStatus(c.status, kids),
        childCount: kids.length,
        /**
         * Root leaves report their SUBTREE's spend, so the board can show a budget being consumed
         * rather than only refusing once it is gone.
         *
         * Emitted for every root rather than only budgeted ones. It was gated on `c.budget`, which
         * nothing ever set — so this line had never executed, and the field it produces was a
         * phantom the frontend had to be told to stop declaring (see tree-board-mirror.test.ts).
         * Now that roots carry budgets it would start firing anyway; making it unconditional means
         * the number is there for leaves created before this shipped too.
         *
         * Deliberately NOT the same as `usage`, which is this leaf alone. A request's cost is its
         * whole tree, and that is the only number a remaining-budget line can honestly be built on.
         */
        ...(c.parentLeafId ? {} : { usageTotal: aggregateUsage(leaves, c, Date.now()) }),
      };
    }));
  }));

  router.post('/', asyncRoute(async (req, res) => {
    try {
      const user = userOf(req);
      const { title, body, branchId, column = 'todo', parentLeafId, blocking = true, personaId, projectId, budget, proposed = false, dependsOn: rawDependsOn, expects: rawExpects } = req.body ?? {};
      if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
      // `column` is untrusted JSON; the union type validates nothing here.
      if (!isLeafColumn(column)) {
        return res.status(400).json({ error: `column must be one of: ${LEAF_COLUMNS.join(', ')}` });
      }

      const leaves = await ownedLeaves(user.id);
      let depth = 0;
      // A child ALWAYS belongs to its parent's request — the whole tree lives and dies together,
      // so letting a caller supply a different one would split a decomposition across requests.
      let resolvedBranchId = typeof branchId === 'string' && branchId ? branchId : uuidv4();
      if (parentLeafId) {
        const parent = leaves.find((c) => c.id === parentLeafId);
        // 404 for both "no such leaf" and "not yours", so this cannot enumerate other tenants.
        if (!parent) return res.status(404).json({ error: 'Parent leaf not found' });
        // Budget is NOT checked for a proposal. A proposal costs nothing — it starts no workflow
        // and spends no tokens — and refusing to even suggest work because the budget is gone
        // hides the very information a human needs to decide whether to raise it. The check moves
        // to the accept route, which is where spend is actually committed.
        if (proposed !== true) {
          const root = rootLeaf(leaves, parent);
          if (root?.budget) {
            const spent = budgetExceeded(root.budget, aggregateUsage(leaves, root, Date.now()));
            if (spent) return res.status(409).json({ error: `${spent} — this leaf's budget covers all of its sub-items` });
          }
        }

        const refusal = canAddChild(parent, childrenOf(leaves, parent.id).length);
        // Returned as a reason rather than a silent no-op: the caller (eventually a planner
        // persona) needs to know it was refused and why, or it will simply ask again.
        if (refusal) return res.status(409).json({ error: refusal });
        depth = parent.depth + 1;
        resolvedBranchId = parent.branchId;
      }

      /**
       * Dependencies were accepted by the type and dropped by this route.
       *
       * `dependsOn` is what makes a plan's steps run in order AND inherit each other's work (see
       * lib/leaf-checkout.ts), and every leaf created through this route silently lost it —
       * verified live: a leaf created with a dependency ran concurrently with the leaf it named.
       * Only the chat proposal path ever set it, so the API said it supported ordering and did not.
       */
      const id = uuidv4();
      /**
       * Filtered to paths the checker would act on — the same rule the tool path uses.
       *
       * This route dropped `expects` entirely at first, exactly as it dropped `dependsOn`: the
       * field existed on the type, the request carried it, and the leaf was created without it. A
       * leaf that silently loses its verification looks identical to one that never had any.
       */
      const expects = usablePaths(Array.isArray(rawExpects) ? rawExpects.map(String) : []);
      const wanted = Array.isArray(rawDependsOn) ? rawDependsOn.map(String) : [];
      // Scoped to leaves this user owns: an id in a request body is untrusted, and depending on
      // another tenant's leaf would leak both its existence and its completion time.
      const dependsOn = wanted.filter((d) => leaves.some((l) => l.id === d));
      if (wouldCycle(id, dependsOn, leaves)) {
        // Refused rather than dropped: a cycle does not fail, it waits forever, and every leaf in
        // it looks like work that is merely slow.
        return res.status(409).json({ error: 'Those dependencies would form a cycle — nothing in it could ever start.' });
      }

      const now = new Date().toISOString();
      const leaf: Leaf = {
        id,
        ownerId: user.id,
        branchId: resolvedBranchId,
        // Shared with the `propose_leaf` tool, so a field cannot be settable on one path and not
        // the other — which is how `dependsOn`, `expects` and `language` each went missing.
        ...normaliseLeafInput(req.body ?? {}),
        title: title.trim().slice(0, 200),
        column,
        // A proposal is a suggestion until someone accepts it: no workflow, no budget spent.
        status: proposed === true ? 'proposed' : 'pending',
        depth,
        blocking: blocking !== false,
        createdAt: now,
        updatedAt: now,
        ...(parentLeafId ? { parentLeafId: String(parentLeafId) } : {}),
        ...(personaId ? { personaId: String(personaId) } : {}),
        ...(projectId ? { projectId: String(projectId) } : {}),
        ...(dependsOn.length ? { dependsOn } : {}),
        // Budgets live on the ROOT only: depth and fan-out caps alone still permit hundreds of
        // workspaces, so the ceiling has to cover the whole subtree.
        /**
         * Every ROOT leaf carries a budget now, not only one that was given a number.
         *
         * `budgetExceeded` has been enforced since it was written and populated by nothing, so the
         * ceiling could never trip — which reads exactly like a ceiling nobody reached. See
         * lib/budget-policy.ts for why this is a flat default rather than an estimate.
         */
        ...(parentLeafId ? {} : { budget: budgetForNewRoot(budget) }),
      };
      await db.saveLeaf(leaf);

      // A proposal gets no workflow at all — that is the entire point of the status. Nothing runs
      // and nothing is spent until someone accepts it, which the accept route handles.
      if (leaf.status === 'proposed') return res.status(201).json(leaf);

      /**
       * Gated the same way the accept route is.
       *
       * This route started the workflow unconditionally, so a leaf created with dependencies ran
       * immediately alongside the leaf it was waiting for — verified live, both were `running` on
       * the first poll. The gate existed in exactly one of the two places a leaf can be started
       * from, which is indistinguishable from no gate for anything created directly.
       *
       * `pending` with no workflow is the resting state; the reconcile loop starts it when the
       * last thing it waits on succeeds.
       */
      const waiting = blockedBy(leaf, leaves);
      if (waiting.length > 0) {
        return res.status(201).json({ ...leaf, waitingFor: waiting.map((w) => ({ id: w.id, title: w.title })) });
      }

      // Start the workflow that backs this leaf, and tell the parent's workflow about it so the
      // child is a real Temporal child rather than just a row pointing at one. Both are
      // best-effort: Temporal being down must not stop someone writing on the board, the same way
      // cluster listing falls back to plain DB polling.
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
          // Position among siblings — what makes the child's workflow id deterministic, so a
          // retried signal addresses the same child instead of spawning a second.
          // Proposals are excluded so the index matches what the parent workflow has actually
          // been told about — counting them would skip an index and break the deterministic id.
          index: childrenOf(leaves, String(parentLeafId)).filter((c) => c.status !== 'proposed').length,
        });
      }
      res.status(201).json(leaf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }));

  /**
   * Accepts a proposed leaf, turning a suggestion into work.
   *
   * Separate from PATCH because this is the moment spend is committed: the budget is re-checked
   * here rather than at proposal time, since a proposal costs nothing and a branch's budget may
   * well have been consumed between the suggestion and the decision.
   */
  router.post('/:id/accept', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });

    // The steps of accepting live in lib/accept-leaf.ts, shared with the automatic path — what
    // differs between them is the decision to accept, never what accepting does.
    const result = await acceptLeaf(
      {
        db,
        startLeaf: (l) => temporalBridge!.startLeaf(l),
        signalLeaf: (id, sig, payload) => temporalBridge!.signalLeaf(id, sig, payload),
        personaOf: async (id) => (id ? (await db.getPersonas()).find((p) => p.id === id) ?? null : null),
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

    const { column, title, body, personaId, maxTokens } = req.body ?? {};
    if (column !== undefined && !isLeafColumn(column)) {
      return res.status(400).json({ error: `column must be one of: ${LEAF_COLUMNS.join(', ')}` });
    }

    /**
     * Raising the request's token budget.
     *
     * Shipped WITH the default that populates budgets, deliberately. A ceiling that starts refusing
     * work with no way to lift it is not a limit, it is an outage — and `accept-leaf.ts` answers a
     * 409 saying "Token budget exhausted" that the reader would otherwise have no response to.
     *
     * Roots only, because the budget is a subtree-wide ceiling; setting one on a child bounds
     * nothing and would read as though it did.
     */
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
    // A leaf with children has a DERIVED status, so moving it by hand is refused rather than
    // silently ignored — dragging a parent while its children run is genuinely ambiguous.
    if (column && childrenOf(leaves, leaf.id).length > 0) {
      return res.status(409).json({ error: 'This leaf\'s state follows its sub-items — move those instead' });
    }
    const updated: Leaf = {
      ...leaf,
      ...(column ? { column } : {}),
      ...(title ? { title: String(title).trim() } : {}),
      ...(body !== undefined ? { body: String(body) } : {}),
      ...(personaId !== undefined ? { personaId: String(personaId) } : {}),
      ...budgetPatch,
      updatedAt: new Date().toISOString(),
    };
    await db.saveLeaf(updated);
    // Moving a leaf IS a signal — that is the whole claim of the board being the state store
    // rather than a view over one. The row is written first so the board stays correct even when
    // Temporal is unreachable.
    if (column) await temporalBridge?.signalLeaf(leaf.id, 'moveLeaf', column);
    res.json(updated);
  }));

  /**
   * Prepare a failure review, and hand it to the conversation.
   *
   * ── WHY THIS NO LONGER CALLS THE MODEL ──
   * It used to: a one-shot completion whose answer was pasted into the transcript as a notice. That
   * put the CONCLUSION in the conversation and left the EVIDENCE behind, so the first follow-up —
   * "why do you think that?" — reached a Koala that had never seen the trace. It also meant a
   * second, separate way of talking to the model, with its own sampling and its own bugs.
   *
   * So this builds the hand-off and stops. The client opens Koala on the leaf's branch and sends
   * this as an ordinary message, which makes the review a normal turn: the evidence is IN the
   * transcript, the reply is a real assistant message, and every follow-up has both.
   */
  router.post('/:id/review', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });

    const trace = await db.getLeafTrace(leaf.id);
    /**
     * The environment the FAILED LEAF ran in — not the reviewer's own.
     *
     * This described the reviewer's sandbox at first, which is a bare `base` image with no tools
     * and no network because a reviewer only reads. Handed that as "the environment", the model
     * concluded Node was not installed and wrote a confident, entirely wrong diagnosis. It was
     * reading a true description of the wrong machine.
     */
    const ranAs = leaf.personaId
      ? (await db.getPersonas()).find((p) => p.id === leaf.personaId && p.ownerId === user.id)
      : undefined;
    const sandbox = ranAs
      ? describeSandbox(personaWorkspace(ranAs, { leafId: leaf.id, ownerId: user.id }, {}))
      // Said rather than omitted: "unknown" is a fact a diagnosis should have, and silence invites
      // invention.
      : 'The persona this leaf ran as is no longer available, so its environment is unknown.';

    res.json({
      branchId: leaf.branchId,
      prompt: buildReviewPrompt(leaf, trace, sandbox),
      leafTitle: leaf.title,
      hasTrace: Boolean(trace?.steps.length),
    });
  }));

  /**
   * Run a failed leaf again.
   *
   * Not a no-op even when nothing has changed: the loop feeds the previous attempt's failure back
   * into the next prompt, so attempt two reads a database attempt one modified. What it cannot fix
   * is an environmental cause, which is what the review above is for — and why the UI offers both
   * rather than making retry the only thing a failed card can do.
   */
  router.post('/:id/retry', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((l) => l.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    if (leaf.status !== 'failed') {
      return res.status(409).json({ error: `Only a failed leaf can be retried; this one is ${leaf.status}.` });
    }

    // Back to `pending` and through the SAME path an acceptance takes, so a retry cannot start work
    // that a dependency has not finished — the one rule a hand-rolled restart would forget.
    const reset = { ...leaf, status: 'proposed' as const, updatedAt: new Date().toISOString() };
    await db.saveLeaf(reset);
    const result = await acceptLeaf(
      {
        db,
        startLeaf: (l) => temporalBridge!.startLeaf(l),
        signalLeaf: (id, sig, payload) => temporalBridge!.signalLeaf(id, sig, payload),
        personaOf: async (id) => (id ? (await db.getPersonas()).find((p) => p.id === id) ?? null : null),
      },
      reset,
      leaves.map((l) => (l.id === reset.id ? reset : l)),
    );
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result.waitingFor.length ? { ...result.leaf, waitingFor: result.waitingFor } : result.leaf);
  }));

  /**
   * Look again at a failure whose work may be sitting on a branch.
   *
   * A leaf that ran out of budget after committing and pushing was recorded as failed, because
   * nothing could check it and a run that never called `finish` makes no claim to fall back on.
   * The wrap-up turn stops that happening again; this is for the ones already on record.
   *
   * It promotes a leaf ONLY when the files it promised are actually on the branch. "There are
   * commits" is not evidence the task was done, and treating it as such would launder the very
   * claim the verified/claimed split exists to keep apart — so when nothing checkable was declared
   * this reports what is there and changes nothing.
   */
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
      // `giteaOwner`/`giteaRepo`, not `owner`/`repo` — the record has never had the latter, and
      // reading them gave `undefined/undefined`, a 404, and a confident "the branch no longer
      // exists" for two leaves whose branches were fine.
      facts = await giteaService.inspectBranch(
        (project as any).giteaOwner, (project as any).giteaRepo, leaf.outputBranch!, leaf.expects ?? [],
      );
      if (!(project as any).giteaOwner || !(project as any).giteaRepo) {
        return res.status(502).json({ error: 'This project has no Gitea repository recorded, so there is nothing to look at.' });
      }
    } catch (err: any) {
      // Reported, not thrown: a recheck that fails must not look like a verdict of "still failed".
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
    // Reported honestly: with Temporal down the row says cancelled but nothing was actually
    // stopped, and pretending otherwise is how a "cancelled" job keeps burning budget.
    res.json({ success: true, workflowSignalled: signalled === true });
  }));

  /**
   * One leaf's turn-by-turn record.
   *
   * Its own route, not a field on the leaf list: a trace is the largest thing a leaf produces and
   * the board never needs it — only a drill-in does. See lib/leaf-trace.ts.
   */
  router.get('/:id/trace', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaf = (await ownedLeaves(user.id)).find((l) => l.id === idOf(req));
    // Ownership is checked against the LEAF, not the trace: a trace with a matching id but no
    // readable leaf is still someone else's.
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const trace = await db.getLeafTrace(leaf.id);
    if (!trace) {
      // 200 with an empty record rather than 404: "this leaf has not run yet" and "this leaf does
      // not exist" are different answers, and the UI shows different things for them.
      return res.json({ steps: [], totalSteps: 0, tokensUsed: 0, missing: true });
    }
    res.json({ ...trace, dropped: droppedCount(trace) });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const user = userOf(req);
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === idOf(req));
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    // Deleting the whole subtree, not just the leaf: orphaned children would be invisible on the
    // board (nothing renders them) while still counting against their root's budget.
    for (const descendant of subtreeOf(leaves, leaf.id)) {
      // Cancel before deleting: a workflow whose row is gone would keep running, and
      // UpdateLeafActivity would silently no-op forever against a leaf that no longer exists.
      await temporalBridge?.signalLeaf(descendant.id, 'cancelLeaf');
      await db.deleteLeaf(descendant.id);
      // The trace is a separate collection, so deleting the leaf does not take it with it. An
      // orphaned trace is unreachable — nothing can read it without a leaf to check ownership
      // against — so it would be pure growth.
      await db.deleteLeafTrace(descendant.id);
    }
    await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
    await db.deleteLeaf(leaf.id);
    await db.deleteLeafTrace(leaf.id);
    res.json({ success: true, deleted: subtreeOf(leaves, leaf.id).length + 1 });
  }));

  return router;
}
