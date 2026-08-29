import type { Leaf } from './leaf-types.js';

export interface PersonaStats {
  finished: number;
  verified: number;
  failed: number;
  verifiedRate?: number;
  medianTokens: number;
  retried: number;
  assigned: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
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

export function byLineage<T extends PersonaLike>(personas: T[]): { root: T; variants: T[] }[] {
  const isRoot = (p: T) => !p.basedOn || !personas.some((q) => q.id === p.basedOn);
  return personas.filter(isRoot).map((root) => ({
    root,
    variants: personas.filter((p) => p.basedOn === root.id),
  }));
}
