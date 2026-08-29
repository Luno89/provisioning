import { describe, it, expect } from 'vitest';
import { resolveDependencyTitles, type Leaf } from './leaves.js';

const leaf = (title: string, id = title): Leaf => ({
  id, ownerId: 'u1', branchId: 'b', title, body: '', column: 'todo',
  status: 'proposed', depth: 0, blocking: true, createdAt: '', updatedAt: '',
} as Leaf);

const all = [leaf('Create the API client'), leaf('Add rate limiting')];

describe('matching a declared dependency to a real leaf', () => {
  it('matches an exact title', () => {
    expect(resolveDependencyTitles(['Create the API client'], all))
      .toEqual({ ids: ['Create the API client'], unresolved: [] });
  });

  it('forgives case, padding and doubled spaces', () => {
    const r = resolveDependencyTitles(['  create the   API CLIENT '], all);
    expect(r.ids).toEqual(['Create the API client']);
    expect(r.unresolved).toEqual([]);
  });

  it('forgives wrapping quotes and a trailing full stop', () => {
    expect(resolveDependencyTitles(['"Create the API client."'], all).ids)
      .toEqual(['Create the API client']);
  });

  it('reports a paraphrase instead of guessing at it', () => {
    const r = resolveDependencyTitles(['Create an API client'], all);

    expect(r.ids).toEqual([]);
    expect(r.unresolved).toEqual(['Create an API client']);
  });

  it('keeps what matched when only some titles are wrong', () => {
    const r = resolveDependencyTitles(['Add rate limiting', 'Nonexistent step'], all);

    expect(r.ids).toEqual(['Add rate limiting']);
    expect(r.unresolved).toEqual(['Nonexistent step']);
  });

  it('returns the unresolved title exactly as given, not normalised', () => {
    expect(resolveDependencyTitles(['  Weird  Title '], all).unresolved).toEqual(['  Weird  Title ']);
  });

  it('counts a title named twice as one dependency', () => {
    const r = resolveDependencyTitles(['Add rate limiting', 'add rate limiting'], all);
    expect(r.ids).toEqual(['Add rate limiting']);
  });

  it('resolves nothing against an empty board', () => {
    expect(resolveDependencyTitles(['Anything'], [])).toEqual({ ids: [], unresolved: ['Anything'] });
  });

  it('handles no dependencies at all', () => {
    expect(resolveDependencyTitles([], all)).toEqual({ ids: [], unresolved: [] });
  });
});
