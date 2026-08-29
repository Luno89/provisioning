import { describe, it, expect } from 'vitest';
import { normaliseTreeInput, primaryProjectId } from './trees.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

describe('the tree type registry', () => {
  it('gives every seeded type a distinct id', () => {
    const ids = TREE_TYPE_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate ids', () => {
    const ids = TREE_TYPE_SEEDS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says what done means for every type', () => {
    for (const spec of TREE_TYPE_SEEDS) expect(spec.doneMeans.length).toBeGreaterThan(20);
  });

  it('knows which types deploy and which produce artefacts', () => {
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'research-paper')!.produces).toBe('artefact');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'decision-brief')!.produces).toBe('artefact');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'api-service')!.produces).toBe('service');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'mcp-server')!.produces).toBe('service');
  });

  it('gives every type a language, since the type decides the workspace', () => {
    for (const spec of TREE_TYPE_SEEDS) expect(spec.language, spec.id).toBeTruthy();
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'dataset')!.language).toBe('python');
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'mcp-server')!.language).toBe('node');
  });

  it('has a type for MCP servers, which the data asked for', () => {
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'mcp-server')!.doneMeans).toMatch(/answers `initialize`/);
  });

  it('accepts any well-formed type id, leaving existence to the store', () => {
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'api-service')).toBe(true);
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'sql-injection')).toBe(false);
  });
});

describe('creating a tree from untrusted input', () => {
  it('requires a name and some type', () => {
    expect(normaliseTreeInput({ type: 'api-service' })).toBeUndefined();
    expect(normaliseTreeInput({ name: 'Koala API' })).toBeUndefined();
    expect(normaliseTreeInput({ name: '   ', type: 'api-service' })).toBeUndefined();
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
