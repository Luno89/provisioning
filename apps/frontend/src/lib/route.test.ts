import { describe, it, expect } from 'vitest';
import { parseHash, formatHash, shouldReplace, resolveView } from './route.js';

/**
 * The URL meaning something.
 *
 * Aimed at the ways a hand-rolled hash router goes wrong quietly: a stray slash producing an empty
 * id that matches nothing, a round trip that loses a segment, and a history that either records
 * nothing or records so much that Back becomes useless.
 */

describe('reading a hash', () => {
  it('reads a view and its ids', () => {
    expect(parseHash('#/grove/t1/b2/l3')).toEqual({ view: 'grove', path: ['t1', 'b2', 'l3'] });
  });

  it('reads a bare view', () => {
    expect(parseHash('#/clusters')).toEqual({ view: 'clusters', path: [] });
  });

  it('treats nothing as nothing, rather than as a view named empty', () => {
    // The first load has no hash at all, and a route of `{view: ''}` would match no view and render
    // a blank page instead of the default.
    for (const empty of ['', '#', '#/', '   ']) expect(parseHash(empty)).toBeUndefined();
  });

  it('drops empty segments instead of passing them on as ids', () => {
    /**
     * `#/grove//l3` is what a formatter produces if a middle id is missing. Keeping the empty
     * string would hand Grove a tree id of '' — which matches no tree, so the pane renders nothing
     * and the navigator looks broken rather than empty.
     */
    expect(parseHash('#/grove//l3')).toEqual({ view: 'grove', path: ['l3'] });
    expect(parseHash('#/grove/t1/')).toEqual({ view: 'grove', path: ['t1'] });
  });

  it('survives a round trip', () => {
    const hash = formatHash('grove', ['tree-1', 'branch-2', 'leaf-3']);
    expect(parseHash(hash)).toEqual({ view: 'grove', path: ['tree-1', 'branch-2', 'leaf-3'] });
  });

  it('round-trips an id containing a slash', () => {
    // No id looks like this today, but an unencoded one would silently split into two segments and
    // shift every id after it by one position.
    const hash = formatHash('grove', ['koala/deadbeef']);
    expect(parseHash(hash)).toEqual({ view: 'grove', path: ['koala/deadbeef'] });
  });

  it('drops trailing empty ids when formatting', () => {
    expect(formatHash('grove', ['t1', '', ''])).toBe('#/grove/t1');
  });
});

describe('what belongs in browser history', () => {
  it('records a change of view', () => {
    expect(shouldReplace({ view: 'grove', path: ['t1'] }, { view: 'clusters', path: [] })).toBe(false);
  });

  it('records moving to a different tree', () => {
    expect(shouldReplace({ view: 'grove', path: ['t1'] }, { view: 'grove', path: ['t2'] })).toBe(false);
  });

  it('does not record every leaf you click inside one tree', () => {
    /**
     * The point. Clicking six cards on a board and then wanting out should be one Back press, not
     * six — a selection within a scope is the same place with a different thing focused.
     */
    const from = { view: 'grove', path: ['t1', 'b1'] };
    expect(shouldReplace(from, { view: 'grove', path: ['t1', 'b1', 'l9'] })).toBe(true);
    expect(shouldReplace(from, { view: 'grove', path: ['t1', 'b2'] })).toBe(true);
  });

  it('replaces on the very first navigation', () => {
    // There is nothing to go back TO on load, and pushing would make the first Back a no-op that
    // looks like the button is broken.
    expect(shouldReplace(undefined, { view: 'grove', path: [] })).toBe(true);
  });
});

describe('links that outlived their view', () => {
  const known = ['grove', 'personas', 'lab', 'clusters'];

  it('sends a retired view to whatever replaced it', () => {
    /**
     * Grove subsumed the old workspace and tree list. A bookmark to either resolved to a view
     * nothing renders — a blank page, which reads as a broken application rather than a moved one.
     */
    for (const gone of ['chat', 'board', 'trees']) {
      expect(resolveView(gone, known, 'clusters')).toBe('grove');
    }
  });

  it('leaves a view that still exists alone', () => {
    expect(resolveView('personas', known, 'clusters')).toBe('personas');
  });

  it('falls back for a name nobody has ever heard of', () => {
    expect(resolveView('nonsense', known, 'clusters')).toBe('clusters');
    expect(resolveView(undefined, known, 'clusters')).toBe('clusters');
  });
});
