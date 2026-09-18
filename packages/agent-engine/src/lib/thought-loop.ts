
export const SIMILAR_ENOUGH = 0.85;

export const REPEATS_BEFORE_STOP = 3;

export const LOOKBACK = 6;

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shingles(text: string): Set<string> {
  const words = normalise(text).split(' ').filter(Boolean);
  if (words.length < 3) return new Set(words.length ? [words.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

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
  thought?: string | undefined;
  action?: string | undefined;
}

const textOf = (t: Turn) => `${t.thought ?? ''} ${t.action ?? ''}`.trim();

export interface LoopVerdict {
  looping: boolean;
  occurrences: number;
  reason: string;
}

export function detectThoughtLoop(turns: Turn[]): LoopVerdict {
  const none: LoopVerdict = { looping: false, occurrences: 0, reason: '' };
  if (turns.length < REPEATS_BEFORE_STOP + 1) return none;

  const recent = turns.slice(-LOOKBACK);
  const texts = recent.map(textOf);

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
