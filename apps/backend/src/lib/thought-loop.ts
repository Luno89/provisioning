/**
 * Noticing that an agent is going in circles, by reading what it is thinking.
 *
 * ── WHY THIS EXISTS ALONGSIDE thrash.ts ──
 * `thrash.ts` catches an agent that produces NOTHING — twenty turns of `ls`, `cat`, `git log`. That
 * is one failure mode and it is well covered. The other is an agent that is busy: it writes files,
 * runs commands, mutates state on every turn, and is still getting nowhere, because it is doing the
 * same thing over and over with cosmetic variation. No production counter can see that, and neither
 * can a step cap — the cap fires at the same number whether the agent is one command from done or
 * has been rewriting the same file eleven times.
 *
 * ── THE SIGNAL ──
 * Near-identical turns. Not identical: a model rephrases itself, changes a variable name, adds a
 * word. So similarity, over word trigrams, which is cheap, deterministic, needs no embedding
 * service and cannot itself be wrong in an interesting way.
 *
 * ── WHY IT IS DELIBERATELY HARD TO TRIGGER ──
 * The expensive mistake here is a FALSE POSITIVE: killing a run that was iterating legitimately.
 * "Run the tests, read the failure, edit the file, run the tests" is repetitive by nature and is
 * exactly what good work looks like. What separates it from a loop is that something CHANGES
 * between the repeats — a different error, a different file, a different reason.
 *
 * So the bar is high on purpose: turns must be very similar (`SIMILAR_ENOUGH`), it must happen
 * several times (`REPEATS_BEFORE_STOP`), and the caller is expected to require that nothing
 * productive happened in between. Any one of those alone would fire on honest work.
 */

/** How alike two turns must be to count as the same thought. Tuned high: rewording is normal. */
export const SIMILAR_ENOUGH = 0.85;

/**
 * How many times one thought must OCCUR before a run is called circular.
 *
 * Occurrences, not matches — three occurrences is a loop, two is a retry. Getting this distinction
 * wrong made the detector silently need four identical turns to fire on an A-B-A-B cycle, which is
 * the shape it exists to catch.
 */
export const REPEATS_BEFORE_STOP = 3;

/** How far back to compare. A loop that takes more than this to come round is not a tight loop. */
export const LOOKBACK = 6;

/**
 * A turn reduced to what it was actually about.
 *
 * Numbers and hex are dropped: a timestamp, a line number or a commit sha changing between two
 * otherwise identical turns is not progress, and keeping them would make every repeat look novel —
 * which is precisely how a loop hides.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word trigrams. Trigrams rather than words so order matters — two turns using the same
 *  vocabulary in a different order are different thoughts. */
export function shingles(text: string): Set<string> {
  const words = normalise(text).split(' ').filter(Boolean);
  if (words.length < 3) return new Set(words.length ? [words.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** Jaccard overlap. 1 is identical, 0 shares nothing. */
export function similarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

export interface Turn {
  /** What it said it was doing — reasoning and prose, whichever the model produced. */
  thought?: string | undefined;
  /** The commands or tool calls it made, joined. Part of a turn's identity. */
  action?: string | undefined;
}

/** One turn as a single comparable string. */
const textOf = (t: Turn) => `${t.thought ?? ''} ${t.action ?? ''}`.trim();

export interface LoopVerdict {
  looping: boolean;
  /** How many times the most-repeated thought occurred, itself included. */
  occurrences: number;
  /** Said in a way a person can check, naming what actually repeated. */
  reason: string;
}

/**
 * Whether the recent turns are the same turn wearing different hats.
 *
 * Compares each turn against the ones before it inside a window rather than only against its
 * immediate predecessor: the common shape is A B A B A, where no two ADJACENT turns match but the
 * run is plainly cycling.
 */
export function detectThoughtLoop(turns: Turn[]): LoopVerdict {
  const none: LoopVerdict = { looping: false, occurrences: 0, reason: '' };
  if (turns.length < REPEATS_BEFORE_STOP + 1) return none;

  const recent = turns.slice(-LOOKBACK);
  const texts = recent.map(textOf);

  // Empty turns are not evidence of anything — a model that said nothing is a different problem,
  // and treating silence as self-similar would fire on it constantly.
  if (texts.every((t) => t.length === 0)) return none;

  let best = { count: 0, sample: '' };
  for (let i = 0; i < texts.length; i++) {
    const subject = texts[i]!;
    if (!subject) continue;
    let count = 0;
    for (let j = i + 1; j < texts.length; j++) {
      if (similarity(subject, texts[j]!) >= SIMILAR_ENOUGH) count += 1;
    }
    if (count > best.count) best = { count, sample: subject };
  }

  // The subject counts as one of its own occurrences.
  const occurrences = best.count + 1;
  if (occurrences < REPEATS_BEFORE_STOP) return { ...none, occurrences };

  const excerpt = best.sample.length > 120 ? `${best.sample.slice(0, 119)}…` : best.sample;
  return {
    looping: true,
    occurrences,
    reason: `The last ${recent.length} turns repeat the same thought ${occurrences} times with no `
      + `meaningful variation: "${excerpt}". This is a loop, not progress.`,
  };
}
