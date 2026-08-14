/**
 * Deciding which proposals are safe to start without being asked.
 *
 * ── WHY THIS EXISTS ──
 * A planning turn produces five or six leaves and then stops. Every one of them sits in `proposed`
 * until a person clicks accept, which means the common case — a plan that is obviously fine — costs
 * six clicks, and a plan nobody looks at costs nothing and does nothing. Measured here: a planning
 * turn produced five well-formed leaves for an MCP server and they sat untouched, which read from
 * the outside as the run having produced nothing at all.
 *
 * ── AND WHY IT IS A POLICY AND NOT A FLAG ──
 * "Accept everything" is not the feature. Accepting work spends a model budget and runs commands in
 * a sandbox, so the question is which proposals are ROUTINE — well-formed, assigned, affordable and
 * not already being done. Anything that fails one of those is held for a human, with the reason
 * said out loud rather than silently skipped.
 *
 * Pure on purpose: what gets started automatically is exactly the kind of decision that should be
 * readable in a test rather than inferred from a log.
 */
import type { Leaf } from './leaves.js';

/** Below this a title or body is a placeholder rather than a description of work. */
const MIN_TITLE = 8;
const MIN_BODY = 40;

/**
 * The most leaves one turn may start by itself.
 *
 * A planner that proposes forty leaves has misunderstood the request, and the failure mode of
 * auto-accept is that it acts on that before anyone reads it. Beyond this the whole batch is held.
 */
export const MAX_AUTO_ACCEPT = 8;

export interface AutoAcceptPolicy {
  /** Off unless switched on. Starting work costs money and runs commands. */
  enabled: boolean;
  /** Accept only leaves the planner assigned a persona to. */
  requirePersona: boolean;
  max: number;
}

export const DEFAULT_POLICY: AutoAcceptPolicy = {
  enabled: false,
  // A leaf with no persona has no declared tools, no egress rules and no model settings — it would
  // run under whatever the default happens to be. That is precisely the decision a human should
  // make, so an unassigned leaf is never routine.
  requirePersona: true,
  max: MAX_AUTO_ACCEPT,
};

export interface Verdict {
  accept: boolean;
  /** Said out loud either way — a held leaf must explain itself, or it looks like a bug. */
  reason: string;
}

/**
 * Whether one proposal is routine enough to start.
 *
 * `existing` is every leaf already on the branch, used for the duplicate check.
 */
export function review(
  leaf: Leaf,
  existing: Leaf[],
  policy: AutoAcceptPolicy = DEFAULT_POLICY,
): Verdict {
  if (leaf.status !== 'proposed') return { accept: false, reason: 'not a proposal' };

  const title = (leaf.title ?? '').trim();
  const body = (leaf.body ?? '').trim();

  if (title.length < MIN_TITLE) {
    return { accept: false, reason: 'the title is too short to say what the work is' };
  }
  if (body.length < MIN_BODY) {
    return { accept: false, reason: 'there is no description of what to do' };
  }
  if (policy.requirePersona && !leaf.personaId) {
    return { accept: false, reason: 'no persona was assigned, so the environment it would run in is undecided' };
  }

  /**
   * A second leaf with the same title is the planner proposing work it already proposed.
   *
   * Compared against everything on the branch rather than only what is running: a plan re-proposed
   * after a replan turn is the exact case this catches, and by then the first copy may already have
   * finished.
   */
  const duplicate = existing.some((other) =>
    other.id !== leaf.id
    && other.status !== 'proposed'
    && (other.title ?? '').trim().toLowerCase() === title.toLowerCase());
  if (duplicate) {
    return { accept: false, reason: 'a leaf with this title has already been accepted' };
  }

  return { accept: true, reason: 'well-formed, assigned and not already being done' };
}

export interface Reviewed {
  leaf: Leaf;
  verdict: Verdict;
}

/**
 * Reviews a whole batch.
 *
 * All-or-nothing on the size limit rather than accepting the first eight: a plan of forty leaves is
 * one bad plan, and starting a fifth of it is worse than starting none of it — it spends budget on
 * work whose shape nobody has agreed to.
 */
export function reviewBatch(
  proposals: Leaf[],
  existing: Leaf[],
  policy: AutoAcceptPolicy = DEFAULT_POLICY,
): Reviewed[] {
  if (!policy.enabled) {
    return proposals.map((leaf) => ({ leaf, verdict: { accept: false, reason: 'auto-accept is off' } }));
  }
  if (proposals.length > policy.max) {
    return proposals.map((leaf) => ({
      leaf,
      verdict: {
        accept: false,
        reason: `${proposals.length} proposals at once is more than the ${policy.max} that may start unattended`,
      },
    }));
  }

  // Accumulated as we go, so two identically-titled leaves in ONE batch do not both pass the
  // duplicate check by each looking only at what came before the batch.
  const seen = [...existing];
  return proposals.map((leaf) => {
    const verdict = review(leaf, seen, policy);
    if (verdict.accept) seen.push({ ...leaf, status: 'pending' });
    return { leaf, verdict };
  });
}
