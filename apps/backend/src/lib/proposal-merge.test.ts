import { describe, it, expect } from 'vitest';
import {
  isRestatement, newProposals, suspectedDuplicates, duplicateNotice, resolvePersonaNamed,
} from './proposal-merge.js';
import type { Persona } from './personas.js';

const persona = (name: string): Persona => ({ id: name.toLowerCase(), ownerId: 'u1', name } as Persona);

const DOC = 'Document MCP Streamable HTTP spec and chosen GitHub endpoints';
const DISCOVERY = 'Write DISCOVERY.md with MCP Streamable HTTP spec and chosen GitHub endpoints';
const OTHERS = [
  'Build the GitHub MCP server with Streamable HTTP transport',
  'Configure Docker build and deployment for the MCP server',
  'Call the deployed GitHub MCP server tools and verify real responses',
];

describe('what is dropped, and it is only the certain case', () => {
  it('drops a title that differs from an existing one only in case and punctuation', () => {
    expect(isRestatement('Add rate-limiting', ['add rate limiting'])).toBe(true);
    expect(isRestatement('Add the CI job.', ['Add the CI job'])).toBe(true);
  });

  it('does NOT drop the real duplicate, because dropping it needs a judgement', () => {
    expect(isRestatement(DISCOVERY, [DOC])).toBe(false);
  });

  it('says no against an empty list, and for an empty title', () => {
    expect(isRestatement('Anything at all', [])).toBe(false);
    expect(isRestatement('', ['Build the server'])).toBe(false);
  });
});

describe('a reply that restates itself verbatim', () => {
  it('creates one leaf, not two', () => {
    const kept = newProposals(
      [{ title: 'Build the server' }, { title: 'build the SERVER' }, { title: 'Write the README' }],
      [],
    );
    expect(kept.map((k) => k.title)).toEqual(['Build the server', 'Write the README']);
  });

  it('keeps the FIRST of a duplicate pair', () => {
    const kept = newProposals([{ title: 'Build it', id: 'a' }, { title: 'build it', id: 'b' }], []);
    expect(kept).toHaveLength(1);
    expect((kept[0] as any).id).toBe('a');
  });

  it('passes everything through when nothing overlaps', () => {
    expect(newProposals([{ title: 'Write the README' }, { title: 'Add a health endpoint' }], ['Deploy'])).toHaveLength(2);
  });
});

describe('the pairs a reviewer is asked about', () => {
  it('reports the duplicate that was actually created', () => {
    const pairs = suspectedDuplicates([DOC, DISCOVERY, ...OTHERS]);
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.a, pairs[0]!.b].sort()).toEqual([DOC, DISCOVERY].sort());
  });

  it('stays quiet about the other stages of that same plan', () => {
    expect(suspectedDuplicates(OTHERS)).toEqual([]);
  });

  it('does not report an exact match, which was already dropped', () => {
    expect(suspectedDuplicates(['Build the server', 'build the SERVER'])).toEqual([]);
  });

  it('leads with the most likely pair', () => {
    const pairs = suspectedDuplicates([DOC, DISCOVERY, 'Add a rate limit to /api/chat', 'Add a rate limit to /api/search']);
    expect(pairs.length).toBeGreaterThan(1);
    expect(pairs[0]!.score).toBeGreaterThanOrEqual(pairs[1]!.score);
  });

  it('says nothing for a single leaf or none at all', () => {
    expect(suspectedDuplicates(['Just the one'])).toEqual([]);
    expect(suspectedDuplicates([])).toEqual([]);
  });
});

describe('the notice a reviewer reads', () => {
  it('is empty when there is nothing to say', () => {
    expect(duplicateNotice([])).toBe('');
  });

  it('quotes both titles and says what to do', () => {
    const text = duplicateNotice(suspectedDuplicates([DOC, DISCOVERY]));
    expect(text).toContain(DOC);
    expect(text).toContain(DISCOVERY);
    expect(text).toMatch(/drop one before accepting/);
  });

  it('reads correctly for one pair and for several', () => {
    const one = duplicateNotice([{ a: 'x', b: 'y', score: 0.5 }]);
    expect(one).toMatch(/^Two leaves look/);
    const many = duplicateNotice([{ a: 'x', b: 'y', score: 0.5 }, { a: 'p', b: 'q', score: 0.4 }]);
    expect(many).toMatch(/^2 pairs of leaves look/);
  });
});

describe('resolving the persona name a model wrote', () => {
  const personas = [persona('Builder'), persona('Researcher'), persona('Reviewer')];

  it('matches exactly, case-insensitively — the behaviour that already worked', () => {
    expect(resolvePersonaNamed('Builder', personas)?.name).toBe('Builder');
    expect(resolvePersonaNamed('builder', personas)?.name).toBe('Builder');
    expect(resolvePersonaNamed('  BUILDER  ', personas)?.name).toBe('Builder');
  });

  it('reads past the wrapping models put around a name', () => {
    expect(resolvePersonaNamed('the Builder', personas)?.name).toBe('Builder');
    expect(resolvePersonaNamed('Builder persona', personas)?.name).toBe('Builder');
    expect(resolvePersonaNamed('the Builder persona', personas)?.name).toBe('Builder');
  });

  it('REFUSES when the loosened match is ambiguous', () => {
    expect(resolvePersonaNamed('Builder', [persona('Backend Builder'), persona('Frontend Builder')])).toBeUndefined();
  });

  it('still resolves an exact name that is also a prefix of another', () => {
    expect(resolvePersonaNamed('Builder', [persona('Builder'), persona('Builder Deluxe')])?.name).toBe('Builder');
  });

  it('gives nothing for a name that does not exist, or no name, or no personas', () => {
    expect(resolvePersonaNamed('Archaeologist', personas)).toBeUndefined();
    expect(resolvePersonaNamed(undefined, personas)).toBeUndefined();
    expect(resolvePersonaNamed('   ', personas)).toBeUndefined();
    expect(resolvePersonaNamed('Builder', [])).toBeUndefined();
  });
});
