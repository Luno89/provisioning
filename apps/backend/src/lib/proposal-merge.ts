import { similarity } from './thought-loop.js';
import type { Persona } from './personas.js';

/**
 * Turning a model's prose plan into leaves without creating work that already exists.
 *
 * ── WHAT ARRIVED, AND WHY THE OBVIOUS FIX DOES NOT WORK ──
 * The merge that keeps prose proposals a `propose_leaf` call did not cover deduped on the exact
 * normalised title. Measured on a real planning turn, what got past it was:
 *
 *     tool:   "Document MCP Streamable HTTP spec and chosen GitHub endpoints"
 *     prose:  "Write DISCOVERY.md with MCP Streamable HTTP spec and chosen GitHub endpoints"
 *
 * The same stage twice. Two agents were going to write one file, and the only thing that stopped it
 * was a person reading the list.
 *
 * The obvious fix is a similarity threshold, and it was written, tested, and thrown away — because
 * lexical similarity ranks these BACKWARDS. Scoring the real pair against work that merely looks
 * alike, using the same word-trigram Jaccard as the circling detector:
 *
 *     0.545   "Document MCP Streamable HTTP spec…" / "Write DISCOVERY.md with MCP Streamable…"
 *     0.667   "Add a rate limit to /api/chat"      / "Add a rate limit to /api/search"
 *
 * The duplicate scores LOWER than two leaves that must both exist. There is no threshold that keeps
 * the second pair and drops the first, and any number chosen here would silently delete a stage of
 * a plan — the exact failure the prose merge was written to fix. The signal that separates them is
 * that one pair differs in filler and the other in the thing being acted on, which a bag of
 * trigrams cannot see.
 *
 * ── SO THE JOB IS SPLIT ──
 * Dropping is done only where it is certain: an exact normalised title match. Everything short of
 * that is REPORTED to the reviewer, who accepts these proposals anyway and who caught this one
 * unaided. A warning that is occasionally unnecessary costs a glance; a silent delete costs a stage
 * and says nothing.
 */

/**
 * How alike two titles must be before the reviewer is asked to look at the pair.
 *
 * Tuned for recall, not precision, which is the opposite of what a dropping threshold would need
 * and is only safe because nothing is dropped on it. The real duplicate scores 0.545 and unrelated
 * stages of the same plan score 0.000–0.067, so 0.35 catches restatements while leaving a plan
 * whose stages are simply about one subject quiet.
 */
export const SIMILAR_ENOUGH_TO_ASK = 0.35;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Whether `title` is the same title as one already in `existing`, ignoring case and punctuation.
 *
 * Deliberately narrow: this is the only test anything is dropped on, so it answers "these are the
 * same string" and not "these are the same work". The second question is `suspectedDuplicates`.
 */
export function isRestatement(title: string, existing: readonly string[]): boolean {
  const target = norm(title);
  if (!target) return false;
  return existing.some((e) => norm(e) === target);
}

/**
 * The proposals in `incoming` that are not already present by title.
 *
 * Compares against `existing` AND against everything kept so far from this batch: one reply can
 * restate itself, since the prose block and the tool calls are the same turn.
 */
export function newProposals<T extends { title: string }>(
  incoming: readonly T[],
  existing: readonly string[],
): T[] {
  const seen = [...existing];
  const kept: T[] = [];
  for (const p of incoming) {
    if (isRestatement(p.title, seen)) continue;
    kept.push(p);
    seen.push(p.title);
  }
  return kept;
}

/** A pair of titles alike enough that a person should decide whether both should exist. */
export interface SuspectedDuplicate {
  a: string;
  b: string;
  score: number;
}

/**
 * Pairs of titles that look like the same work described twice.
 *
 * Returns them for a notice rather than acting on them — see the header for why acting would be
 * wrong. Highest-scoring first, so a long plan leads with its most likely duplicate.
 */
export function suspectedDuplicates(titles: readonly string[]): SuspectedDuplicate[] {
  const found: SuspectedDuplicate[] = [];
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const a = titles[i]!;
      const b = titles[j]!;
      // Exact matches are already dropped by `newProposals`; reporting them would be noise.
      if (norm(a) === norm(b)) continue;
      const score = similarity(a, b);
      if (score >= SIMILAR_ENOUGH_TO_ASK) found.push({ a, b, score });
    }
  }
  return found.sort((x, y) => y.score - x.score);
}

/** The warning text for a plan, or '' when there is nothing to say. */
export function duplicateNotice(pairs: readonly SuspectedDuplicate[]): string {
  if (!pairs.length) return '';
  const lines = pairs.map((p) => `  · "${p.a}"\n    "${p.b}"`);
  return (
    `${pairs.length === 1 ? 'Two leaves look' : `${pairs.length} pairs of leaves look`} like the same work `
    + `described twice:\n${lines.join('\n')}\n`
    + 'If they are, drop one before accepting — two agents doing one job will overwrite each other.'
  );
}

/**
 * The persona a model meant when it wrote a name.
 *
 * ── WHY THIS IS TOLERANT, AND WHERE IT STOPS ──
 * A persona carries the whole environment — toolchain, network reach, tools, time budget — so the
 * two ways of getting it wrong cost nothing alike. Assigning nobody leaves a leaf that cannot run,
 * which is visible and one click to fix. Assigning the WRONG persona builds a Go service with a
 * Python image and fails somewhere far away with an error about neither.
 *
 * So it reads past "the ", a trailing "persona", and case; and it refuses the moment a loosened
 * match becomes AMBIGUOUS rather than picking one of two. Exact case-insensitive equality is tried
 * first and always wins, so no name that resolved before resolves differently now.
 */
export function resolvePersonaNamed(
  wanted: string | undefined,
  personas: readonly Persona[],
): Persona | undefined {
  const loosen = (s: string) => norm(s).replace(/^the\b/, '').replace(/\bpersona$/, '').trim();
  const target = loosen(String(wanted ?? ''));
  if (!target) return undefined;

  const exact = personas.filter((p) => p.name.trim().toLowerCase() === String(wanted).trim().toLowerCase());
  if (exact.length === 1) return exact[0];

  const loosened = personas.filter((p) => loosen(p.name) === target);
  if (loosened.length === 1) return loosened[0];

  // Last resort: one persona whose name contains the whole of what was asked for, or vice versa.
  // Only when exactly one does — two candidates means the model was not specific enough to act on.
  const partial = personas.filter((p) => {
    const n = loosen(p.name);
    return n.includes(target) || target.includes(n);
  });
  return partial.length === 1 ? partial[0] : undefined;
}
