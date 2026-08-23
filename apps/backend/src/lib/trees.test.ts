import { describe, it, expect } from 'vitest';
import { normaliseTreeInput, primaryProjectId } from './trees.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

describe('the tree type registry', () => {
  it('gives every seeded type a distinct id', () => {
    // Ids key the record and appear on every tree, so a collision would make two types one.
    const ids = TREE_TYPE_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate ids', () => {
    const ids = TREE_TYPE_SEEDS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says what done means for every type', () => {
    // A type with no definition of done cannot seed acceptance, which is the point of having types.
    for (const spec of TREE_TYPE_SEEDS) expect(spec.doneMeans.length).toBeGreaterThan(20);
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
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'research-paper')!.produces).toBe('artefact');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'decision-brief')!.produces).toBe('artefact');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'api-service')!.produces).toBe('service');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'mcp-server')!.produces).toBe('service');
  });

  it('gives every type a language, since the type decides the workspace', () => {
    // The type is an opinionated template, not a label: a persona installs what it needs on top,
    // but the image is where the work starts.
    for (const spec of TREE_TYPE_SEEDS) expect(spec.language, spec.id).toBeTruthy();
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'dataset')!.language).toBe('python');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'mcp-server')!.language).toBe('node');
  });

  it('has a type for MCP servers, which the data asked for', () => {
    /**
     * Four of the five trees on this instance were MCP servers labelled `api-service` or
     * `infra-module`, because there was nothing closer. A type people reach for by approximation is
     * a type that should exist.
     */
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'mcp-server')!.doneMeans).toMatch(/answers `initialize`/);
  });

  it('accepts any well-formed type id, leaving existence to the store', () => {
    /**
     * `isTreeType` is gone with the union it guarded. Existence is a question about an owner's
     * records — `resolveTreeType` answers it, and `POST /api/trees` refuses an id nobody has.
     * What survives here is that the seeds are internally consistent.
     */
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'api-service')).toBe(true);
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'sql-injection')).toBe(false);
  });
});

describe('creating a tree from untrusted input', () => {
  it('requires a name and some type', () => {
    expect(normaliseTreeInput({ type: 'api-service' })).toBeUndefined();
    expect(normaliseTreeInput({ name: 'Koala API' })).toBeUndefined();
    expect(normaliseTreeInput({ name: '   ', type: 'api-service' })).toBeUndefined();
    /**
     * Shape only. Types are owned records, so whether 'nope' exists is a question for the store —
     * `POST /api/trees` resolves it against the caller's own types and refuses with the valid ids.
     * A hardcoded list here would be the duplication this change removes.
     */
    expect(normaliseTreeInput({ name: 'Koala API', type: 'nope' })).toEqual({ name: 'Koala API', type: 'nope' });
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
