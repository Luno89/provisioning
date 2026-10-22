import { describe, it, expect } from 'vitest';
import { fuseRRF, buildMemoryQuery, memoryTerms, MAX_QUERY_TERMS, RRF_K } from './memory-rank.js';

describe('RRF fusion', () => {
  it('ranks a memory both halves found above one either half ranked first', () => {
    const fused = fuseRRF({
      dense: ['dense-first', 'both'],
      sparse: ['sparse-first', 'both'],
    });

    expect(fused[0]!.id).toBe('both');
    expect(fused[0]!.via).toEqual(['dense', 'sparse']);
  });

  it('computes the score the paper specifies', () => {
    const fused = fuseRRF({ dense: ['a', 'b'], sparse: ['b'] });
    const byId = Object.fromEntries(fused.map((h) => [h.id, h.score]));

    expect(byId.a).toBeCloseTo(1 / (RRF_K + 0), 10);
    expect(byId.b).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 0), 10);
  });

  it('keeps a lone list in its original order', () => {
    const fused = fuseRRF({ sparse: ['x', 'y', 'z'] });
    expect(fused.map((h) => h.id)).toEqual(['x', 'y', 'z']);
  });

  it('is stable when scores tie, rather than ordering by hash', () => {
    const fused = fuseRRF({ dense: ['a'], sparse: ['b'] });
    expect(fused.map((h) => h.id)).toEqual(['a', 'b']);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 10);
  });

  it('returns nothing when both halves failed', () => {
    expect(fuseRRF({ dense: [], sparse: [] })).toEqual([]);
  });
});

describe('the Quickwit query', () => {
  it('asks for terms rather than the whole phrase', () => {
    const q = buildMemoryQuery('Add rate limiting to the upload route', { ownerId: 'u1' });

    expect(q).toContain('owner_id:"u1"');
    expect(q).toContain('body:rate');
    expect(q).toContain('body:limiting');
    expect(q).toContain(' OR ');
    expect(q).not.toContain('"Add rate limiting');
  });

  it('cannot be made to inject a field term', () => {
    const q = buildMemoryQuery('layout" OR owner_id:"victim', { ownerId: 'u1' });

    expect(q).toBe('owner_id:"u1" AND (body:layout OR body:owner OR body:victim)');
    expect(q.match(/owner_id:/g)).toHaveLength(1);
  });

  it('degrades to the owner alone when nothing usable is left', () => {
    expect(buildMemoryQuery('!! ?? ..', { ownerId: 'u1' })).toBe('owner_id:"u1"');
  });

  it('scopes to the owner even when the owner id contains quotes', () => {
    expect(buildMemoryQuery('x', { ownerId: 'a"b' })).toContain('owner_id:"ab"');
  });
});

describe('query terms', () => {
  it('drops one- and two-character words, which match everything', () => {
    expect(memoryTerms('a in the repository')).toEqual(['the', 'repository']);
  });

  it('deduplicates and caps, so a long body is not a 400-term OR', () => {
    const many = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    expect(memoryTerms(many)).toHaveLength(MAX_QUERY_TERMS);
    expect(memoryTerms('repo repo repo')).toEqual(['repo']);
  });
});
