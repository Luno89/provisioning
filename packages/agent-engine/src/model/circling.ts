const EXCERPT_CHARS = 1500;
const SAME_CIRCLE = 0.5;

function trigrams(text: string): Set<string> {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) grams.add(words.slice(i, i + 3).join(' '));
  return grams;
}

export function sameCircle(before: string, now: string): boolean {
  const a = trigrams(before);
  const b = trigrams(now);
  if (a.size === 0 || b.size === 0) return a.size === b.size;
  let shared = 0;
  for (const gram of b) if (a.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared) >= SAME_CIRCLE;
}

export function whereItCircled(thinking: string): string {
  const text = thinking.trim();
  return text.length <= EXCERPT_CHARS ? text : `…${text.slice(-EXCERPT_CHARS)}`;
}

export function circlingNudge(thinking: string): string {
  return [
    'You were stopped mid-thought because your thinking was going in circles: you were writing the same reasoning again.',
    'This is where you were:',
    '',
    whereItCircled(thinking),
    '',
    'Do not weigh the options again. Pick the one that best fits what you were asked and act on it now.',
    'If what you need cannot be done, say so plainly in your answer, with what you do know.',
  ].join('\n');
}

export const circlingNotice = (why: string) =>
  `its thinking went in circles (${why}); it was asked again, shown where it was stuck and told to decide`;
