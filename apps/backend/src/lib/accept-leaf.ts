import { aggregateUsage, budgetExceeded, blockedBy, childrenOf, rootLeaf, type Leaf } from './leaves.js';
import { usableAcceptancePlan } from './acceptance.js';
import { canRunLeaf } from './persona-scope.js';
import { hollowChecks, explainHollow } from './acceptance-validation.js';
import type { Database } from './db-interface.js';
import type { PersonaPack } from '@koala/harness-types';

export interface AcceptDeps {
  db: Pick<Database, 'saveLeaf' | 'getBranches'>;
  startLeaf?: ((leaf: Leaf) => Promise<string | undefined>) | undefined;
  signalLeaf?: ((leafId: string, signal: 'addChild', payload: unknown) => Promise<unknown>) | undefined;
  now?: () => number;
  packOf?: (id: string | undefined) => Promise<Pick<PersonaPack, 'name' | 'tools' | 'canRunLeaf'> | null | undefined>;
}

export type AcceptResult =
  | { ok: true; leaf: Leaf; waitingFor: { id: string; title: string }[] }
  | { ok: false; status: number; error: string };

export async function acceptLeaf(deps: AcceptDeps, leaf: Leaf, leaves: Leaf[]): Promise<AcceptResult> {
  if (leaf.status !== 'proposed') {
    return { ok: false, status: 409, error: 'This leaf has already been accepted' };
  }

  if (!leaf.packId) {
    return {
      ok: false,
      status: 409,
      error: 'This leaf has no pack, so it would run with no repository and its work would be '
        + 'discarded when the sandbox is destroyed. Assign one first.',
    };
  }

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

  const hollow = hollowChecks(plan);
  if (hollow.length === plan.length) {
    return { ok: false, status: 409, error: explainHollow(hollow) };
  }

  if (deps.packOf) {
    const pack = await deps.packOf(leaf.packId);
    if (!canRunLeaf(pack)) {
      return {
        ok: false,
        status: 409,
        error: `${pack?.name ?? 'That pack'} is for chat only and has no sandbox to work in — `
          + 'no toolchain, no repository, no network policy. Assign a pack that builds.',
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
    waitingFor: waiting.map((w) => ({ id: w.id, title: w.title })),
  };
}
