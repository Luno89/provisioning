/**
 * Applying a partial update without deleting everything it did not mention.
 *
 * ── THE BUG THIS REPLACES ──
 * The `save*Info` functions take a partial and rebuild a whole record from a hand-written list of
 * fields. Anything missing from that list is dropped on write — silently, with no type error,
 * because the argument genuinely has the field.
 *
 * It has bitten twice that we know of. A Crawl4AI credential was minted, threaded through the
 * bridge, written, and gone by the time anything read it back — the pod held a token the backend
 * could not know. And an audit of the same functions found `saveProjectInfo` never carried
 * `ownerId`, so saving a project through it quietly orphaned it.
 *
 * ── ABSENCE MEANS UNCHANGED ──
 * That is what "save this partial info" already promised, and the allowlist was a broken
 * implementation of it. Merging onto the stored record makes the promise true, and makes the lists
 * unnecessary rather than something to keep up to date.
 *
 * `undefined` is treated as absent too. Callers spread objects with optional keys, and a key that
 * arrives explicitly undefined means "I had nothing to say about this" rather than "erase it" —
 * the opposite reading is how a status update wipes a configuration.
 *
 * ── WHAT THIS GIVES UP ──
 * You can no longer clear a field by omitting it. Nothing in this codebase does that today (no
 * `$unset`, no `delete` before a save), and doing it deliberately needs a deliberate mechanism
 * rather than the absence of one.
 */
export function mergeRecord<T extends object>(existing: T | undefined, patch: Partial<T>): Partial<T> {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
  return { ...(existing ?? {} as T), ...defined };
}
