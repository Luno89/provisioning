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

  it('knows which types deploy and which produce artefacts', () => {
    /**
     * Replaces a `usesRepo` boolean that said research projects get NO repository. That was written
     * before `leaf-project.ts` made repositories non-optional — because opt-in lost work: a leaf
     * wrote correct, tested code into a sandbox that was then destroyed, and reported success.
     *
     * `produces` keeps the real distinction (a service must answer; an artefact is read) without
     * reviving the one that would delete work.
     */
    expect(treeTypeSpec('research-paper').produces).toBe('artefact');
    expect(treeTypeSpec('decision-brief').produces).toBe('artefact');
    expect(treeTypeSpec('api-service').produces).toBe('service');
    expect(treeTypeSpec('mcp-server').produces).toBe('service');
  });

  it('gives every type a language, since the type decides the workspace', () => {
    // The type is an opinionated template, not a label: a persona installs what it needs on top,
    // but the image is where the work starts.
    for (const spec of TREE_TYPES) expect(spec.language, spec.id).toBeTruthy();
    expect(treeTypeSpec('dataset').language).toBe('python');
    expect(treeTypeSpec('mcp-server').language).toBe('node');
  });

  it('has a type for MCP servers, which the data asked for', () => {
    /**
     * Four of the five trees on this instance were MCP servers labelled `api-service` or
     * `infra-module`, because there was nothing closer. A type people reach for by approximation is
     * a type that should exist.
     */
    expect(treeTypeSpec('mcp-server').doneMeans).toMatch(/answers `initialize`/);
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
