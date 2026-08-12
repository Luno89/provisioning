import { describe, it, expect } from 'vitest';
import { TREE_TYPES, isTreeType, treeTypeSpec, normaliseTreeInput, primaryProjectId } from './trees.js';

describe('the tree type registry', () => {
  it('has a spec for every type, so treeTypeSpec can never miss', () => {
    // treeTypeSpec asserts non-null. That is only safe while the table covers the union, and this
    // is what keeps it covered when someone adds a member.
    for (const spec of TREE_TYPES) expect(treeTypeSpec(spec.id).id).toBe(spec.id);
  });

  it('has no duplicate ids', () => {
    const ids = TREE_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says what done means for every type', () => {
    // A type with no definition of done cannot seed acceptance, which is the point of having types.
    for (const spec of TREE_TYPES) expect(spec.doneMeans.length).toBeGreaterThan(20);
  });

  it('knows which types produce files and which produce answers', () => {
    expect(treeTypeSpec('research-paper').usesRepo).toBe(false);
    expect(treeTypeSpec('decision-brief').usesRepo).toBe(false);
    expect(treeTypeSpec('api-service').usesRepo).toBe(true);
  });

  it('rejects a type that is not in the table', () => {
    // Arrives as untrusted JSON; the union checks nothing at runtime.
    expect(isTreeType('api-service')).toBe(true);
    expect(isTreeType('sql-injection')).toBe(false);
    expect(isTreeType(undefined)).toBe(false);
    expect(isTreeType(42)).toBe(false);
  });
});

describe('creating a tree from untrusted input', () => {
  it('requires a name and a known type', () => {
    expect(normaliseTreeInput({ type: 'api-service' })).toBeUndefined();
    expect(normaliseTreeInput({ name: 'Koala API' })).toBeUndefined();
    expect(normaliseTreeInput({ name: '   ', type: 'api-service' })).toBeUndefined();
    expect(normaliseTreeInput({ name: 'Koala API', type: 'nope' })).toBeUndefined();
  });

  it('keeps a valid name, type and goal', () => {
    expect(normaliseTreeInput({ name: '  Koala API  ', type: 'api-service', goal: ' serve leaves ' }))
      .toEqual({ name: 'Koala API', type: 'api-service', goal: 'serve leaves' });
  });

  it('omits an empty goal rather than storing a blank', () => {
    expect(normaliseTreeInput({ name: 'x', type: 'dataset', goal: '   ' })).toEqual({ name: 'x', type: 'dataset' });
  });

  it('bounds what a caller can store', () => {
    const out = normaliseTreeInput({ name: 'n'.repeat(500), type: 'dataset', goal: 'g'.repeat(9000) })!;
    expect(out.name.length).toBe(120);
    expect(out.goal!.length).toBe(2000);
  });
});

describe('choosing a repository for a leaf that did not name one', () => {
  it('takes the primary, which is the first', () => {
    expect(primaryProjectId({ projectIds: ['a', 'b'] })).toBe('a');
  });

  it('has none before the tree owns any repository', () => {
    expect(primaryProjectId({})).toBeUndefined();
    expect(primaryProjectId({ projectIds: [] })).toBeUndefined();
  });
});
