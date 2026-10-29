import type { Check } from '../../eval/level2/score.js';
import { KIND_TITLES, SIGNAL_KINDS, type SignalKind } from '../../engine/lib/signal-kinds.js';

export const NOTICED_PATCH = 'check-noticed';

export interface Noticed {
  kind: SignalKind;
  said: string;
}

export const noticedProblem = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((kind) => !SIGNAL_KINDS.includes(kind as SignalKind))) return `noticed lists what Koala should notice, each one of ${SIGNAL_KINDS.join(', ')}`;
  return undefined;
};

export function noticedChecks(expected: readonly SignalKind[], found: readonly Noticed[]): Check[] {
  const checks: Check[] = expected.map((kind) => {
    const seen = found.find((one) => one.kind === kind);
    return { what: `Koala notices: ${KIND_TITLES[kind].toLowerCase()}`, passed: Boolean(seen), detail: seen ? seen.said : 'it noticed nothing of the kind' };
  });
  const unexpected = found.filter((one) => !expected.includes(one.kind));
  checks.push({
    what: 'Koala notices nothing it should not',
    passed: unexpected.length === 0,
    detail: unexpected.length === 0 ? (found.length ? 'only what the check expected' : 'nothing in its runs looked like poisoning') : unexpected.map((one) => `${one.kind}: ${one.said}`).join('; '),
  });
  return checks;
}
