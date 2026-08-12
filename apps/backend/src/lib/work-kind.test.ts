import { describe, it, expect } from 'vitest';
import { WORK_KINDS, isWorkKind, asWorkKind } from './work-kind.js';

describe('the one vocabulary for what a piece of work is', () => {
  it('has exactly the three kinds', () => {
    // A fourth would need a home in every consumer; this is what makes adding one a decision rather
    // than a literal typed into a fifth file.
    expect([...WORK_KINDS]).toEqual(['planning', 'code', 'research']);
  });

  it('rejects anything that is not one of them', () => {
    // Arrives as untrusted JSON. An unrecognised kind selected no loop at all and was stored anyway.
    expect(isWorkKind('code')).toBe(true);
    expect(isWorkKind('sandbox')).toBe(false);
    expect(isWorkKind('')).toBe(false);
    expect(isWorkKind(undefined)).toBe(false);
    expect(isWorkKind(3)).toBe(false);
  });
});

describe('reading a kind from outside', () => {
  it('still understands the old spelling for execution work', () => {
    /**
     * Experiments are stored documents that outlive a rename. A task whose kind silently became
     * undefined would fall back to the execution loop — right by accident today, and wrong the
     * moment that default changes.
     */
    expect(asWorkKind('sandbox')).toBe('code');
  });

  it('passes the current spellings through', () => {
    for (const kind of WORK_KINDS) expect(asWorkKind(kind)).toBe(kind);
  });

  it('gives nothing back for a typo, so the caller picks its own default', () => {
    // Inheriting a default from a misspelling is how a task ends up in a loop nobody chose.
    expect(asWorkKind('reserch')).toBeUndefined();
    expect(asWorkKind(null)).toBeUndefined();
    expect(asWorkKind({})).toBeUndefined();
  });
});
