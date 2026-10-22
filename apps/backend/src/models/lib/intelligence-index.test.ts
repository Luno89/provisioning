import { describe, it, expect } from 'vitest';
import {
  indexOf, normalizeModelKey, buildIntelligenceIndex, intelligenceFor,
} from './intelligence-index.js';

describe('indexOf', () => {
  it('reads the index off the record', () => {
    expect(indexOf({ artificial_analysis_intelligence_index: 60.1 })).toBe(60.1);
  });

  it('reads it out of evaluations, where the payload has also carried it', () => {
    expect(indexOf({ evaluations: { artificial_analysis_intelligence_index: 42 } })).toBe(42);
  });

  it('accepts a camelCase spelling', () => {
    expect(indexOf({ intelligenceIndex: 7 })).toBe(7);
  });

  it('coerces a numeric string, which their payload sometimes uses', () => {
    expect(indexOf({ intelligence_index: '55.5' })).toBe(55.5);
  });

  it('treats a missing, non-numeric or negative score as absent, not as zero', () => {
    expect(indexOf({})).toBeUndefined();
    expect(indexOf({ intelligence_index: 'n/a' })).toBeUndefined();
    expect(indexOf({ intelligence_index: -1 })).toBeUndefined();
  });

  it('keeps a genuine zero, which is a score and not an absence', () => {
    expect(indexOf({ intelligence_index: 0 })).toBe(0);
  });
});

describe('normalizeModelKey', () => {
  it('drops the vendor prefix a gateway adds', () => {
    expect(normalizeModelKey('anthropic/claude-opus-5-fast')).toBe('claudeopus5fast');
  });

  it('reduces case and punctuation so two catalogues can agree', () => {
    expect(normalizeModelKey('Claude-Opus-5_fast')).toBe('claudeopus5fast');
    expect(normalizeModelKey('claude opus 5 fast')).toBe('claudeopus5fast');
  });

  it('leaves a bare id alone but for case', () => {
    expect(normalizeModelKey('GPT-4o')).toBe('gpt4o');
  });
});

describe('buildIntelligenceIndex', () => {
  const catalogue = [
    { slug: 'claude-opus-5-fast', artificial_analysis_intelligence_index: 71 },
    { slug: 'gpt-4o', evaluations: { intelligence_index: 62 } },
    { slug: 'no-score-here' },
  ];

  it('matches a gateway id through its vendor prefix', () => {
    const index = buildIntelligenceIndex(catalogue);
    expect(intelligenceFor('anthropic/claude-opus-5-fast', index)).toBe(71);
    expect(intelligenceFor('openai/gpt-4o', index)).toBe(62);
  });

  it('has nothing for a model their catalogue does not score', () => {
    const index = buildIntelligenceIndex(catalogue);
    expect(intelligenceFor('vendor/no-score-here', index)).toBeUndefined();
    expect(intelligenceFor('vendor/never-heard-of-it', index)).toBeUndefined();
  });

  it('indexes under every naming a record offers', () => {
    const index = buildIntelligenceIndex([{ id: 'the-id', name: 'The Name', intelligence_index: 5 }]);
    expect(intelligenceFor('x/the-id', index)).toBe(5);
    expect(intelligenceFor('x/The Name', index)).toBe(5);
  });

  it('keeps the first score when two records collapse to one key, not the last', () => {
    // Overwriting would make the answer depend on their ordering, which we do not control.
    const index = buildIntelligenceIndex([
      { slug: 'gpt-4o', intelligence_index: 62 },
      { slug: 'GPT_4O', intelligence_index: 99 },
    ]);
    expect(intelligenceFor('openai/gpt-4o', index)).toBe(62);
  });

  it('is empty for an empty catalogue', () => {
    expect(buildIntelligenceIndex([]).size).toBe(0);
  });
});
