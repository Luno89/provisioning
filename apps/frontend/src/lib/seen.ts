/**
 * "Since you last looked" — a marker that survives being looked at.
 *
 * ── THE BUG THIS EXISTS TO FIX ──
 * Both the board and the home page recorded "seen" in an unmount cleanup:
 *
 *   useEffect(() => () => localStorage.setItem(key, new Date().toISOString()), []);
 *
 * Under React StrictMode — which this application runs in — every effect is mounted, unmounted and
 * mounted again on the first render. So the cleanup fired **immediately**, stamping the marker with
 * `now` before anybody had read anything, and the ref that held the previous value was re-read on
 * the second mount and picked up the value just written.
 *
 * The result: "3 changes since you last looked" was permanently zero. A live board and a dead one
 * looked identical, which is the exact failure the feature was built to prevent.
 *
 * ── THE FIX ──
 * Two parts, and both are needed:
 *
 *   1. The previous value is cached per key for the life of the page, so a remount cannot re-read a
 *      value that this page itself has since written.
 *   2. The new value is written after a DWELL, not on unmount. Opening something and leaving
 *      immediately should not count as having seen it, and a delay is also immune to StrictMode's
 *      synchronous remount.
 */

/** Read-once cache, so a remount cannot observe our own write. */
const firstRead = new Map<string, string | undefined>();

export interface SeenOptions {
  /** How long the thing must stay open before it counts as seen. */
  dwellMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => string;
}

/**
 * The value to compare against — stable for the life of the page.
 *
 * Deliberately NOT re-read from storage on later calls: the whole failure was a component observing
 * a timestamp that it had caused.
 */
export function lastSeen(key: string, options: SeenOptions = {}): string | undefined {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!firstRead.has(key)) {
    firstRead.set(key, storage?.getItem(key) ?? undefined);
  }
  return firstRead.get(key);
}

/**
 * Marks the key seen after a dwell, and returns a cancel function.
 *
 * The caller wires the cancel into its effect teardown, so navigating away before the dwell elapses
 * leaves the marker untouched — which is what makes a glance different from a read.
 */
export function markSeenAfterDwell(key: string, options: SeenOptions = {}): () => void {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const now = options.now ?? (() => new Date().toISOString());
  // Long enough that StrictMode's synchronous remount cannot reach it, short enough that a real
  // look counts.
  const dwell = options.dwellMs ?? 4000;

  const timer = setTimeout(() => storage?.setItem(key, now()), dwell);
  return () => clearTimeout(timer);
}

/** Test seam only — the cache is per page in real use. */
export function resetSeenCache(): void {
  firstRead.clear();
}
