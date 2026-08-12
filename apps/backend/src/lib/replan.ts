/**
 * Giving the planner a turn once work comes back.
 *
 * ── THE GAP THIS FILLS ──
 * A plan was written once, before any of it ran, and nothing ever revisited it. The board the
 * planner reads carried a leaf's title, body, dependencies and persona — and nothing about what the
 * leaf actually produced. So it could not answer the question that decides what happens next: given
 * what came back, is more work needed?
 *
 * A scraper that returns a table of prices might be the whole request, or might be the input to an
 * API nobody has proposed yet. No mechanical check can tell those apart, because the difference is
 * what the person wanted rather than what the code does.
 *
 * There was already a `maxReplans` budget enforcing a ceiling on a loop that did not exist.
 *
 * ── WHAT IT MAY NOT DO ──
 * Propose work. It does not decide the request is finished — a model declaring its own work
 * complete is the unverified claim this codebase has spent a great deal of effort removing, and
 * completion stays with the acceptance checks, which run a command and read an exit code.
 */
import type { Leaf } from './leaves.js';

/** Statuses that mean a leaf will not change again on its own. */
const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Whether this leaf is the end of a chain.
 *
 * ── WHY THE FRONTIER AND NOT EVERY LEAF ──
 * A leaf that something else is waiting on does not need a planning turn: finishing it releases the
 * dependent, which is already the next step. Only a leaf with nothing behind it represents work
 * whose continuation nobody has decided yet.
 *
 * Cheaper than replanning per leaf — a five-leaf chain triggers once rather than five times — and
 * earlier than waiting for the whole request, which would leave a finished scraper idle until the
 * slowest unrelated leaf caught up.
 */
export function isFrontier(leaf: Pick<Leaf, 'id' | 'status'>, all: Leaf[]): boolean {
  if (!FINISHED.has(leaf.status)) return false;
  return !all.some((other) => other.id !== leaf.id && (other.dependsOn ?? []).includes(leaf.id));
}

/**
 * Whether a planning turn is worth spending, and why not when it is not.
 *
 * The reason is returned rather than logged so the caller can record it against the leaf — a replan
 * that silently did not happen is indistinguishable from one that happened and proposed nothing.
 */
export function shouldReplan(
  leaf: Pick<Leaf, 'id' | 'status' | 'branchId'>,
  all: Leaf[],
  budget: { maxReplans?: number | undefined } | undefined,
  used: number,
): { replan: boolean; reason?: string } {
  if (!isFrontier(leaf as Leaf, all)) return { replan: false, reason: 'other work is waiting on this leaf' };
  /**
   * A failed leaf still gets a turn.
   *
   * Its failure is exactly the kind of thing that changes a plan — the approach did not work and
   * something else is needed. Skipping it would mean the planner only ever sees the runs that went
   * well, which is the wrong half.
   */
  if (budget?.maxReplans !== undefined && used >= budget.maxReplans) {
    return { replan: false, reason: `replan budget spent (${used}/${budget.maxReplans})` };
  }
  // Nothing has finished on this branch except the leaf itself and it produced nothing to react to.
  const siblings = all.filter((l) => l.branchId === leaf.branchId);
  if (siblings.some((l) => !FINISHED.has(l.status) && !(l.dependsOn ?? []).includes(leaf.id))) {
    // Unrelated work is still running. Its results will arrive, and replanning now would decide
    // against half a picture and then have to decide again.
    return { replan: false, reason: 'unrelated work on this branch is still running' };
  }
  return { replan: true };
}

/** What a finished leaf actually produced, as much of it as is worth putting in a prompt. */
export interface LeafOutcome {
  title: string;
  status: string;
  /** Whether anything checked it, as opposed to the agent saying it was done. */
  verified: boolean;
  /** The persona that did it, by name. */
  persona: string | null;
  /** Its answer, when it produced one. Trimmed — this goes into a prompt. */
  findings?: string;
  /** What it reported doing. A claim, and labelled as one. */
  summary?: string;
  /** Where the code landed, when it wrote any. */
  branch?: string;
}

/** Enough to reason about, far short of what a 20,000-character answer would cost in a prompt. */
export const MAX_OUTCOME_CHARS = 1500;

export function summariseOutcomes(
  leaves: Leaf[],
  branchId: string,
  personaName: (id: string) => string | undefined,
): LeafOutcome[] {
  return leaves
    .filter((l) => l.branchId === branchId && FINISHED.has(l.status))
    .map((l) => ({
      title: l.title,
      status: l.status,
      verified: Boolean(l.verified),
      persona: (l.personaId && personaName(l.personaId)) || null,
      ...(l.findings?.trim() ? { findings: l.findings.slice(0, MAX_OUTCOME_CHARS) } : {}),
      ...(l.summary?.trim() ? { summary: l.summary.slice(0, MAX_OUTCOME_CHARS) } : {}),
      ...(l.outputBranch ? { branch: l.outputBranch } : {}),
    }));
}

/**
 * The turn itself.
 *
 * Says what came back and asks one question. Deliberately does NOT ask whether the request is
 * finished: that is decided by running the acceptance checks, and inviting an opinion on it would
 * produce one that reads like a verdict.
 */
export function buildReplanPrompt(request: string, outcomes: LeafOutcome[]): string {
  return [
    `The request was: ${request}`,
    '',
    'This work has finished:',
    ...outcomes.map((o) => [
      `- ${o.title} — ${o.status}${o.verified ? ', verified' : ', unverified'}${o.persona ? `, by ${o.persona}` : ''}`,
      ...(o.findings ? [`  what it found: ${o.findings}`] : []),
      ...(o.summary && !o.findings ? [`  it reported: ${o.summary}`] : []),
      ...(o.branch ? [`  landed on: ${o.branch}`] : []),
    ].join('\n')),
    '',
    'Given what actually came back — not what was planned — is any further work needed to satisfy',
    'the request? Something may now be possible that was not before, or an approach may have turned',
    'out not to work.',
    '',
    'If yes, propose it with propose_leaf, assigning a persona to each. If nothing further is needed,',
    'say so in one sentence and propose nothing. Do not re-propose work that already succeeded.',
  ].join('\n');
}
