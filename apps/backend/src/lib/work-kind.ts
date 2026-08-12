/**
 * The runtime half of `WorkKind`.
 *
 * The type lives in `@koala/harness-types`, which is types-only on purpose — every import of it is
 * erased before anything executes, so there is no build step and no way for it to be stale at
 * runtime. Values that need to exist when the program runs live here instead.
 *
 * What this is FOR is validation at a boundary. A kind arrives as untrusted JSON from a request
 * body or out of a stored document, and the union checks nothing at runtime — an unrecognised kind
 * selected no loop at all and was written to the database anyway.
 */
import type { WorkKind } from '@koala/harness-types';

export const WORK_KINDS: readonly WorkKind[] = ['planning', 'code', 'research'];

export function isWorkKind(value: unknown): value is WorkKind {
  return typeof value === 'string' && (WORK_KINDS as readonly string[]).includes(value);
}

/**
 * A kind from outside, or undefined.
 *
 * ── WHY `sandbox` IS STILL ACCEPTED ──
 * Experiment tasks called execution work `sandbox` while leaves called it `code`. Nothing writes
 * `sandbox` any more, but experiments are stored documents that outlive a rename, and a task whose
 * kind silently became `undefined` would fall back to the execution loop — which is right by
 * accident today and would stop being right the moment the default changes.
 *
 * Undefined for anything unrecognised, so a caller decides its own default rather than inheriting
 * one from a typo.
 */
export function asWorkKind(value: unknown): WorkKind | undefined {
  if (value === 'sandbox') return 'code';
  return isWorkKind(value) ? value : undefined;
}
