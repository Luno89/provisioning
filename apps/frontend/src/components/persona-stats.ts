import type { Leaf } from './leaf-types.js';

/**
 * How a persona has actually performed, measured from the work it did.
 *
 * ── WHY THIS EXISTS ──
 * The persona list showed what each one is CONFIGURED to be — its prompt, its egress, its step
 * budget — and nothing at all about whether it is any good. Meanwhile every leaf already carries
 * `personaId`, `verified`, `usageTotal.tokens` and its attempt history, and the Lab runs experiments
 * comparing exactly this. The numbers existed; nothing put them next to the thing they describe.
 *
 * ── WHY THE VERIFIED RATE IS OVER FINISHED WORK ONLY ──
 * Counting running or proposed leaves in the denominator would make a persona look worse the moment
 * work was queued to it, which is a measure of how busy it is, not how well it does. And it is
 * `verified`, never `succeeded`: a rate built on the agent's own report is a rate that measures
 * nothing, which is the same flattening the board is arranged to avoid.
 */

export interface PersonaStats {
  /** Leaves that reached a terminal state — the denominator for the rate. */
  finished: number;
  /** Finished leaves whose work was actually checked. */
  verified: number;
  failed: number;
  /** Undefined rather than 0 when nothing has finished: "0%" and "no data" are different claims. */
  verifiedRate?: number;
  /** Median, not mean — one 600k-token run should not redefine what the persona typically costs. */
  medianTokens: number;
  /** Leaves that needed more than one attempt, the cheapest signal that something is wrong. */
  retried: number;
  /** Everything assigned to it, including work not yet started. */
  assigned: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Even counts average the two middles, so a two-run persona is not silently reported as the
  // larger of them.
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? 0);
}

const FINISHED = new Set(['succeeded', 'failed']);

export function statsFor(personaId: string, leaves: Leaf[]): PersonaStats {
  const mine = leaves.filter((l) => l.personaId === personaId);
  const finished = mine.filter((l) => FINISHED.has(l.status));
  const verified = finished.filter((l) => l.verified === true);
  const tokens = mine.map((l) => l.usage?.tokens ?? 0).filter((t) => t > 0);

  return {
    assigned: mine.length,
    finished: finished.length,
    verified: verified.length,
    failed: finished.filter((l) => l.status === 'failed').length,
    ...(finished.length > 0 ? { verifiedRate: verified.length / finished.length } : {}),
    medianTokens: median(tokens),
    retried: mine.filter((l) => (Array.isArray(l.attempts) ? l.attempts.length : 0) > 1).length,
  };
}

export interface PersonaLike {
  id: string;
  name: string;
  basedOn?: string;
}

/**
 * Personas grouped by what they derive from, parents first.
 *
 * Three of the nine on this instance are `Researcher` variants and they sat scattered through a
 * grid in creation order, so the one comparison a person actually wants to make — this against the
 * thing it was forked from — was the one the layout made hardest.
 */
export function byLineage<T extends PersonaLike>(personas: T[]): { root: T; variants: T[] }[] {
  const isRoot = (p: T) => !p.basedOn || !personas.some((q) => q.id === p.basedOn);
  // A persona whose parent was deleted is a root: it has nothing left to be compared against, and
  // dropping it would hide a persona that still runs work.
  return personas.filter(isRoot).map((root) => ({
    root,
    variants: personas.filter((p) => p.basedOn === root.id),
  }));
}
