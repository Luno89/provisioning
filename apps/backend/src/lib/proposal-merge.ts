import { similarity } from './thought-loop.js';
import type { Persona } from './personas.js';

export const SIMILAR_ENOUGH_TO_ASK = 0.35;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function isRestatement(title: string, existing: readonly string[]): boolean {
  const target = norm(title);
  if (!target) return false;
  return existing.some((e) => norm(e) === target);
}

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

export interface SuspectedDuplicate {
  a: string;
  b: string;
  score: number;
}

export function suspectedDuplicates(titles: readonly string[]): SuspectedDuplicate[] {
  const found: SuspectedDuplicate[] = [];
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const a = titles[i]!;
      const b = titles[j]!;
      if (norm(a) === norm(b)) continue;
      const score = similarity(a, b);
      if (score >= SIMILAR_ENOUGH_TO_ASK) found.push({ a, b, score });
    }
  }
  return found.sort((x, y) => y.score - x.score);
}

export function duplicateNotice(pairs: readonly SuspectedDuplicate[]): string {
  if (!pairs.length) return '';
  const lines = pairs.map((p) => `  · "${p.a}"\n    "${p.b}"`);
  return (
    `${pairs.length === 1 ? 'Two leaves look' : `${pairs.length} pairs of leaves look`} like the same work `
    + `described twice:\n${lines.join('\n')}\n`
    + 'If they are, drop one before accepting — two agents doing one job will overwrite each other.'
  );
}

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

  const partial = personas.filter((p) => {
    const n = loosen(p.name);
    return n.includes(target) || target.includes(n);
  });
  return partial.length === 1 ? partial[0] : undefined;
}
