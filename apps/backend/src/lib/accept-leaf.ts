/**
 * Starting a proposal, in one place.
 *
 * ── WHY THIS IS NOT IN THE ROUTE ──
 * It was, and accepting is not one step: it is a budget check, a status change, a decision about
 * whether anything blocks it, starting a workflow only if nothing does, and telling the parent it
 * gained a child. Auto-accept needs every one of those, and a second copy of five coupled steps is
 * how the two leaf-creation paths in this codebase drifted apart three times.
 *
 * So the HTTP route and the automatic path call this. What differs between them is only the
 * DECISION to accept — see auto-accept.ts — never what accepting does.
 */
import { aggregateUsage, budgetExceeded, blockedBy, childrenOf, rootLeaf, type Leaf } from './leaves.js';
import type { Database } from './db-interface.js';

export interface AcceptDeps {
  db: Pick<Database, 'saveLeaf'>;
  /** Absent when Temporal is unreachable; the leaf is still accepted and the loop starts it later. */
  startLeaf?: ((leaf: Leaf) => Promise<string | undefined>) | undefined;
  /** Returns whether the signal landed; the bridge reports false when the workflow is gone. */
  signalLeaf?: ((leafId: string, signal: 'addChild', payload: unknown) => Promise<unknown>) | undefined;
  now?: () => number;
}

export type AcceptResult =
  | { ok: true; leaf: Leaf; waitingFor: { id: string; title: string }[] }
  | { ok: false; status: number; error: string };

export async function acceptLeaf(deps: AcceptDeps, leaf: Leaf, leaves: Leaf[]): Promise<AcceptResult> {
  if (leaf.status !== 'proposed') {
    return { ok: false, status: 409, error: 'This leaf has already been accepted' };
  }

  /**
   * A leaf with no persona is refused here, not only by the automatic path.
   *
   * `usesRepo` treats an absent persona as NO, so an unassigned leaf gets no checkout — and an
   * agent that finds /work empty does not stop, it creates the directories it wants and works
   * there. Measured: two leaves wrote 11 KB and 5 KB of correct, tested code into a sandbox with no
   * repository, pushed nothing, and were marked succeeded because their tests passed. The work was
   * destroyed with the pod.
   *
   * auto-accept already refused this. The button did not, so accepting by hand bypassed the one
   * check that would have caught it — which is exactly how it happened.
   */
  if (!leaf.personaId) {
    return {
      ok: false,
      status: 409,
      error: 'This leaf has no persona, so it would run with no repository and its work would be '
        + 'discarded when the sandbox is destroyed. Assign one first.',
    };
  }

  const root = rootLeaf(leaves, leaf);
  if (root?.budget) {
    const spent = budgetExceeded(root.budget, aggregateUsage(leaves, root, (deps.now ?? Date.now)()));
    if (spent) {
      return { ok: false, status: 409, error: `${spent} — accepting more work would exceed this branch's budget` };
    }
  }

  const accepted: Leaf = { ...leaf, status: 'pending', updatedAt: new Date().toISOString() };
  await deps.db.saveLeaf(accepted);

  /**
   * Started only when its turn has come.
   *
   * A leaf waiting on another stays `pending` with no workflow — which is what `pending` already
   * means. The reconcile loop starts it when the last thing it waits on succeeds. Accepting five
   * leaves at once used to start five workflows at once, so a plan whose steps built on each other
   * ran every step against an empty sandbox.
   */
  const waiting = blockedBy(accepted, leaves);
  if (waiting.length === 0) {
    const workflowId = await deps.startLeaf?.(accepted);
    if (workflowId) {
      accepted.workflowId = workflowId;
      await deps.db.saveLeaf(accepted);
    }
    if (accepted.parentLeafId) {
      await deps.signalLeaf?.(accepted.parentLeafId, 'addChild', {
        leafId: accepted.id,
        title: accepted.title,
        blocking: accepted.blocking,
        index: childrenOf(leaves, accepted.parentLeafId).filter((c) => c.status !== 'proposed').length,
      });
    }
  }

  return {
    ok: true,
    leaf: accepted,
    // Said back, because a leaf that is accepted and not running otherwise looks broken.
    waitingFor: waiting.map((w) => ({ id: w.id, title: w.title })),
  };
}
