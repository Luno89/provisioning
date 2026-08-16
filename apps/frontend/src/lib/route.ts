/**
 * Where you are, kept in the URL.
 *
 * ── WHY THIS EXISTS ──
 * The whole application was a sixteen-value `useState` with no router of any kind: no
 * `react-router`, no `pushState`, no hash. Three things followed, and all three were reported as
 * "the UI is all over the place":
 *
 *   - You could not link anyone to anything. Not a leaf, not a board, not a failure.
 *   - Browser Back left the application entirely, because nothing had ever pushed a history entry.
 *   - **Refresh always dumped you at Clusters**, however deep you were. Watching a leaf run and
 *     reloading meant four clicks to get back, every time.
 *
 * ── WHY THE HASH AND NOT A ROUTER ──
 * A router would have meant restructuring a 3,200-line component that currently works, for the same
 * user-visible result. The hash needs no server route (the dev server and the production static
 * host both serve `/` unchanged), no dependency, and no change to how views render — they keep
 * reading one piece of state. This is deliberately the smallest thing that makes a URL mean
 * something, and it is reversible.
 *
 * The shape is `#/view/a/b/c`: a view name and up to three positional ids, which is exactly what
 * Grove needs (tree, branch, leaf) and more than anything else needs.
 */

export interface Route {
  view: string;
  /** Positional ids under the view — for Grove: tree, branch, leaf. */
  path: string[];
}

/**
 * Parses a hash into a route.
 *
 * Empty segments are dropped rather than preserved, so `#/grove//abc` cannot produce a tree id of
 * `''` that then fails to match any tree and silently shows nothing.
 */
export function parseHash(hash: string): Route | undefined {
  const trimmed = hash.replace(/^#\/?/, '').trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split('/').map(decodeURIComponent).filter(Boolean);
  const view = parts[0];
  if (!view) return undefined;
  return { view, path: parts.slice(1) };
}

/** Formats a route back into a hash. Ids are encoded, since a branch title never reaches here but a
 *  future id could contain a slash. */
export function formatHash(view: string, path: string[] = []): string {
  const segments = [view, ...path.filter(Boolean)].map(encodeURIComponent);
  return `#/${segments.join('/')}`;
}

/**
 * Whether navigating from one route to another should REPLACE the history entry.
 *
 * Selecting a different leaf in the same tree is not a new place you would want to press Back
 * through one at a time — it is the same page with a different thing focused. Changing view is.
 * Without this, closing a board after clicking six cards means six Back presses to escape.
 */
export function shouldReplace(from: Route | undefined, to: Route): boolean {
  if (!from) return true;
  if (from.view !== to.view) return false;
  // Same view, and the first id (the scope — a tree, for Grove) is unchanged.
  return (from.path[0] ?? '') === (to.path[0] ?? '');
}
