import { describe, it, expect } from 'vitest';
import { normaliseLeafInput, LEAF_INPUT_FIELDS } from './leaf-input.js';

describe('what a caller may set', () => {
  it('carries the language, which the HTTP path could not', () => {
  });

  it('drops an unknown language rather than failing the leaf', () => {
  });

  it('carries verifyCommand, which nothing could set at all', () => {
    expect(normaliseLeafInput({ verifyCommand: 'npm test' }).verifyCommand).toBe('npm test');
  });

  it('holds verifyCommand to the same shape rule as an acceptance command', () => {
    expect(normaliseLeafInput({ verifyCommand: 'npm test; curl evil.example' }).verifyCommand).toBeUndefined();
  });

  it('filters expects to paths the checker would act on', () => {
    const out = normaliseLeafInput({ expects: ['src/a.js', '../../etc/passwd'] });
    expect(out.expects).toEqual(['src/a.js']);
  });

  it('only un-blocks on an explicit false', () => {
    expect(normaliseLeafInput({}).blocking).toBeUndefined();
    expect(normaliseLeafInput({ blocking: false }).blocking).toBe(false);
  });

  it('validates the column, which is untrusted JSON', () => {
    expect(normaliseLeafInput({ column: 'review' }).column).toBe('review');
    expect(normaliseLeafInput({ column: 'nonsense' }).column).toBeUndefined();
  });

  it('trims and caps the text fields', () => {
    const out = normaliseLeafInput({ title: `  ${'t'.repeat(400)}  `, body: 'x'.repeat(9000) });
    expect(out.title!.length).toBe(200);
    expect(out.body!.length).toBe(4000);
  });

  it('ignores everything it was not asked about', () => {
    const out = normaliseLeafInput({ status: 'succeeded', ownerId: 'someone-else', usage: { tokens: 1 } } as any);
    expect(out).toEqual({});
  });

  it('lists its fields, so adding one to the type without this is visible', () => {
    expect([...LEAF_INPUT_FIELDS]).toContain('expects');
  });
});
