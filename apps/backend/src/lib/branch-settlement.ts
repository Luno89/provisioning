/**
 * What a conversation actually left behind, once it has stopped moving.
 *
 * ── THE PROBLEM ──
 * A leaf lived in its branch forever. So a failed leaf stayed a failed leaf, permanently, and the
 * project's list of what needs attention only ever grew. Measured on this instance: three failures
 * from a run that finished the previous night were still sitting at the top of the page the next
 * day, indistinguishable from work that had just broken — because nothing in the model had a way to
 * say "that run is over, here is what it managed and here is what it did not".
 *
 * It also made the project's context expensive and dumb: a new conversation was handed 26 raw leaf
 * titles from finished runs, when what it needed was one line per run plus the short list of things
 * that are still owed.
 *
 * ── WHAT SETTLEMENT IS ──
 * A branch settles when nothing on it can move on its own — no proposal awaiting a decision, none
 * accepted-and-waiting, none running. What it produces is not a new record but a READING of the
 * records already there: what it delivered, what it only claimed, and what is still owed.
 *
 * ── AND WHY IT IS DERIVED, NOT STORED ──
 * Storing an outcome means a write path that can be missed, and a stored outcome that disagrees
 * with the leaves is worse than no outcome at all — the same hazard as any denormalised field here.
 * Derived, it is always right and there is nothing to migrate.
 *
 * ── WHAT IS DELIBERATELY NOT DONE ──
 * Nothing is deleted. A settled leaf keeps its record and its trace, because being able to replay a
 * run later is a thing this system was explicitly built to do. Settling changes where work APPEARS,
 * not whether it exists: outstanding work moves up to the project as something to decide about,
 * instead of sitting in a branch forever as a failure nobody can clear.
 */
import type { Branch, Leaf } from './leaves.js';

/** Work that can still move without anybody doing anything. */
const LIVE = new Set(['proposed', 'pending', 'running']);

export interface Settlement {
  settled: boolean;
  /** Succeeded and checked. The only list that is evidence rather than report. */
  delivered: Leaf[];
  /** Succeeded, unchecked. Kept apart from delivered everywhere else, so kept apart here. */
  claimed: Leaf[];
  /** Failed, or cancelled with the work still wanted — what a re-proposal would be about. */
  outstanding: Leaf[];
  /** Still moving. Empty exactly when `settled`. */
  live: Leaf[];
}

export function settlementOf(leaves: Leaf[]): Settlement {
  const live = leaves.filter((l) => LIVE.has(l.status));
  const succeeded = leaves.filter((l) => l.status === 'succeeded');
  return {
    settled: live.length === 0 && leaves.length > 0,
    delivered: succeeded.filter((l) => l.verified === true),
    claimed: succeeded.filter((l) => l.verified !== true),
    /**
     * Failures only. A cancelled leaf was stopped on purpose, and re-proposing it would undo a
     * decision somebody made deliberately — the same reasoning that keeps cancelled work off the
     * board and out of the project's context.
     */
    outstanding: leaves.filter((l) => l.status === 'failed'),
    live,
  };
}

/** Longest error kept in a citation. Enough to recognise the failure, not enough to be a wall. */
export const MAX_EVIDENCE_CHARS = 160;

/**
 * What actually happened to one leaf, from the records rather than from anyone's report.
 *
 * ── WHY A SUMMARY NEEDS CITING ──
 * "12 delivered, 2 not delivered" is a count, and a count is only as trustworthy as the thing that
 * produced it. Half of what finishes here is a model's report on its own work, so a summary that
 * does not say WHAT was checked is a summary you cannot act on: you cannot tell the twelve that
 * passed a test from the twelve that merely said they were done.
 *
 * So each line carries its evidence — what checked it, where the code went, or why it failed. The
 * distinction that matters most is the one this system exists to preserve: `checked` never renders
 * the same as `reported`.
 */
export function evidenceFor(leaf: Leaf): string {
  const clip = (t: string) => {
    const flat = t.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_EVIDENCE_CHARS ? `${flat.slice(0, MAX_EVIDENCE_CHARS - 1)}…` : flat;
  };

  if (leaf.status === 'failed') {
    const attempts = Array.isArray(leaf.attempts) ? leaf.attempts : [];
    const last = attempts[attempts.length - 1]?.error;
    const count = attempts.length
      ? `failed after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`
      : 'failed';
    // The error is the whole point: it is what decides whether another attempt would go
    // differently, and without it a retry is a guess.
    return last ? `${count} — last error: ${clip(last)}` : count;
  }

  if (leaf.status === 'cancelled') return 'stopped deliberately';
  if (leaf.status === 'running') return 'running now';
  if (leaf.status === 'pending') return 'accepted, waiting its turn';
  if (leaf.status === 'proposed') return 'proposed, awaiting a decision';

  // Succeeded. What, if anything, actually checked it.
  const check = leaf.expects?.length
    ? `produced ${leaf.expects.join(', ')}`
    : leaf.verifyCommand
      ? `passed \`${clip(leaf.verifyCommand)}\``
      : 'a check passed';

  if (!leaf.verified) {
    /**
     * The sentence that must never be softened. An unverified success is still a success — most
     * work is not test-shaped — but it is a report, and saying so is the entire safeguard.
     */
    return leaf.merged
      ? 'the agent reported success and it merged; nothing checked it'
      : 'the agent reported success; nothing checked it';
  }

  if (leaf.merged) return `${check}, merged to the default branch`;
  if (leaf.outputBranch) return `${check}, pushed to ${leaf.outputBranch} but NOT merged`;
  return check;
}

/**
 * One line describing what a finished conversation came to.
 *
 * Assembled from the records rather than written by a model. A summary that costs a model call is a
 * summary that is sometimes missing, sometimes wrong, and always slower — and there is no judgement
 * needed to count what finished. The judgement, "should this be attempted again", is left to the
 * planner, which is the thing that can actually weigh it.
 */
export function summariseBranch(branch: Pick<Branch, 'title' | 'acceptanceOutcome'>, s: Settlement): string {
  if (!s.settled) return '';
  const parts: string[] = [];
  if (s.delivered.length) parts.push(`${s.delivered.length} delivered`);
  if (s.claimed.length) parts.push(`${s.claimed.length} claimed but unchecked`);
  if (s.outstanding.length) parts.push(`${s.outstanding.length} not delivered`);
  const counts = parts.length ? parts.join(', ') : 'nothing finished';
  // The acceptance verdict is about the REQUEST, not the individual leaves, so it is reported
  // separately rather than folded into the counts.
  const verdict = branch.acceptanceOutcome === 'passed' ? '; acceptance passed'
    : branch.acceptanceOutcome === 'failed' ? '; acceptance failed'
      : '';
  return `"${branch.title}" — ${counts}${verdict}`;
}

/**
 * A finished run, with each unfinished piece carrying the reason it is unfinished.
 *
 * The counts alone were not enough to act on: "2 not delivered" tells you there is a decision to
 * make and nothing about how to make it.
 */
export function citedSummary(branch: Pick<Branch, 'title' | 'acceptanceOutcome' | 'acceptanceFailedCheck'>, s: Settlement): string[] {
  if (!s.settled) return [];
  const lines = [summariseBranch(branch, s)];

  if (branch.acceptanceOutcome === 'failed' && branch.acceptanceFailedCheck) {
    // Which check, not just that one failed — "the acceptance check failed" tells nobody which part
    // broke.
    lines.push(`    acceptance stopped at: ${branch.acceptanceFailedCheck}`);
  }
  for (const leaf of s.outstanding) {
    lines.push(`    not delivered — ${leaf.title}: ${evidenceFor(leaf)}`);
  }
  if (s.claimed.length) {
    // Named rather than counted, because these are the ones most likely to be wrong and least
    // likely to be looked at.
    for (const leaf of s.claimed) lines.push(`    unchecked — ${leaf.title}: ${evidenceFor(leaf)}`);
  }
  return lines;
}

export interface ProjectStanding {
  /**
   * The finished runs, as lines.
   *
   * Lines rather than one entry per run: a cited summary is a heading plus a line for each thing it
   * did not deliver or did not check, so the count of entries is not the count of runs. Naming it
   * `summaries` implied otherwise and a test believed it.
   */
  finishedLines: string[];
  /** Everything the project delivered, by title, so it is not built twice. */
  delivered: string[];
  /**
   * Work attempted and not delivered, across every settled conversation.
   *
   * This is the list the next planning turn should be deciding about — and the reason a failure
   * does not have to live in a branch forever.
   */
  outstanding: { title: string; attempts: number; from: string; evidence: string }[];
  /** Conversations still in flight, which are described by their leaves rather than a summary. */
  liveBranches: { branch: Branch; leaves: Leaf[] }[];
}

/**
 * Where a project stands, reading every conversation under it.
 *
 * Settled conversations collapse to a line plus whatever they still owe. Live ones are left as
 * leaves, because a run in progress has no outcome yet and its detail is what a sibling
 * conversation would need in order to stay out of its way.
 */
export function projectStanding(branches: Branch[], leaves: Leaf[]): ProjectStanding {
  const finishedLines: string[] = [];
  const delivered: string[] = [];
  const outstanding: ProjectStanding['outstanding'] = [];
  const liveBranches: ProjectStanding['liveBranches'] = [];

  for (const branch of branches) {
    const mine = leaves.filter((l) => l.branchId === branch.id);
    if (!mine.length) continue;
    const s = settlementOf(mine);

    if (!s.settled) {
      liveBranches.push({ branch, leaves: mine });
      continue;
    }

    finishedLines.push(...citedSummary(branch, s));
    // Claimed counts as built: unchecked is not the same as absent, and rebuilding it would be
    // worse than the missing check.
    delivered.push(...[...s.delivered, ...s.claimed].map((l) => l.title));
    outstanding.push(...s.outstanding.map((l) => ({
      title: l.title,
      attempts: Array.isArray(l.attempts) ? l.attempts.length : 0,
      from: branch.title,
      evidence: evidenceFor(l),
    })));
  }

  return { finishedLines, delivered, outstanding, liveBranches };
}
