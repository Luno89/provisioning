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
import { usableAcceptancePlan } from './acceptance.js';
import { canRunLeaf } from './persona-scope.js';
import { hollowChecks, explainHollow } from './acceptance-validation.js';
import type { Database } from './db-interface.js';
import type { PersonaScope } from '@koala/harness-types';

export interface AcceptDeps {
  db: Pick<Database, 'saveLeaf' | 'getBranches'>;
  /** Absent when Temporal is unreachable; the leaf is still accepted and the loop starts it later. */
  startLeaf?: ((leaf: Leaf) => Promise<string | undefined>) | undefined;
  /** Returns whether the signal landed; the bridge reports false when the workflow is gone. */
  signalLeaf?: ((leafId: string, signal: 'addChild', payload: unknown) => Promise<unknown>) | undefined;
  now?: () => number;
  /**
   * Looks a persona up by id. Optional so existing callers keep working; absent skips the chat-only
   * check rather than failing acceptance over a dependency someone did not pass.
   *
   * Returns the SCOPE as well as the name, because the check is now what the persona can do rather
   * than what it is called — see `canRunLeaf`. The name is still returned, for the refusal message.
   */
  personaOf?: (id: string | undefined) => Promise<{ name: string; scope?: PersonaScope } | null | undefined>;
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

  /**
   * Nothing runs until somebody has said how we will know it worked.
   *
   * ── WHY THIS BLOCKS RATHER THAN WARNS ──
   * `reviewPlan` has warned `no-acceptance` all along and it was ignored, because a warning that
   * costs nothing to skip is a warning that gets skipped. Measured on a real end-to-end run:
   * `acceptance` was null, `acceptanceRunAt` said NEVER RAN, and four leaves went green while
   * nothing exercised the thing they add up to. The run reported success on four individually
   * passing pieces that had never been assembled and tried.
   *
   * Per-leaf checks cannot cover this by construction — each one proves its own piece, and the
   * failure being guarded against is the pieces not adding up. `AcceptRequestActivity` is already
   * wired and already skips honestly when there is no plan; the missing part was ever having one.
   *
   * Checked on the BRANCH, so declaring it once covers every leaf on it.
   */
  const branch = (await deps.db.getBranches()).find((b) => b.id === leaf.branchId);
  const plan = usableAcceptancePlan(branch?.acceptance);
  if (plan.length === 0) {
    return {
      ok: false,
      status: 409,
      error: 'Nothing would check the finished result. Per-leaf checks prove each piece works; '
        + 'only an acceptance plan proves the assembled whole does. Ask the planner to call '
        + 'set_acceptance for this request, then accept again.',
    };
  }

  /**
   * And the plan has to be able to fail.
   *
   * `set_acceptance` refuses these at the point they are written, which is where a model can still
   * fix one. This is the same rule at the gate, for the plans that predate that refusal and for
   * any path that writes a branch without going through the tool — a check that cannot fail is
   * indistinguishable from no check at all, and it was passing this gate a moment ago.
   */
  const hollow = hollowChecks(plan);
  if (hollow.length === plan.length) {
    return { ok: false, status: 409, error: explainHollow(hollow) };
  }

  /**
   * A chat persona can talk about work; it cannot do it.
   *
   * A persona carries the whole sandbox — language, egress, repository, budget — and a chat persona
   * has none of those, because "anything" is not a toolchain. A leaf assigned to one would run in
   * an environment nobody chose, which is the same failure as a leaf with no persona at all,
   * arriving by a route that looks assigned.
   *
   * Refused here rather than in the executor: ten minutes into a sandbox is a bad place to discover
   * it, and the fix is one click on the board.
   *
   * The test is `canRunLeaf`, which reads the absent environment. It used to compare the name to
   * "Koala" — so renaming Koala made it assignable, and any new chat persona was assignable from
   * the moment it was written.
   */
  if (deps.personaOf) {
    const persona = await deps.personaOf(leaf.personaId);
    if (!canRunLeaf(persona)) {
      return {
        ok: false,
        status: 409,
        error: `${persona?.name ?? 'That persona'} is for chat only and has no sandbox to work in — `
          + 'no toolchain, no repository, no network policy. Assign a persona that builds.',
      };
    }
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
