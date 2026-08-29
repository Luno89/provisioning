import { describe, it, expect } from 'vitest';
import { parseHash, formatHash, shouldReplace, resolveView } from './route.js';

describe('reading a hash', () => {
  it('reads a view and its ids', () => {
    expect(parseHash('#/grove/t1/b2/l3')).toEqual({ view: 'grove', path: ['t1', 'b2', 'l3'] });
  });

  it('reads a bare view', () => {
    expect(parseHash('#/clusters')).toEqual({ view: 'clusters', path: [] });
  });

  it('treats nothing as nothing, rather than as a view named empty', () => {
    for (const empty of ['', '#', '#/', '   ']) expect(parseHash(empty)).toBeUndefined();
  });

  it('drops empty segments instead of passing them on as ids', () => {
    expect(parseHash('#/grove//l3')).toEqual({ view: 'grove', path: ['l3'] });
    expect(parseHash('#/grove/t1/')).toEqual({ view: 'grove', path: ['t1'] });
  });

  it('survives a round trip', () => {
    const hash = formatHash('grove', ['tree-1', 'branch-2', 'leaf-3']);
    expect(parseHash(hash)).toEqual({ view: 'grove', path: ['tree-1', 'branch-2', 'leaf-3'] });
  });

  it('round-trips an id containing a slash', () => {
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
    const from = { view: 'grove', path: ['t1', 'b1'] };
    expect(shouldReplace(from, { view: 'grove', path: ['t1', 'b1', 'l9'] })).toBe(true);
    expect(shouldReplace(from, { view: 'grove', path: ['t1', 'b2'] })).toBe(true);
  });

  it('replaces on the very first navigation', () => {
    expect(shouldReplace(undefined, { view: 'grove', path: [] })).toBe(true);
  });
});

describe('links that outlived their view', () => {
  const known = ['grove', 'personas', 'lab', 'clusters'];

  it('sends a retired view to whatever replaced it', () => {
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
