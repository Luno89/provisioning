import { describe, expect, it } from 'vitest';
import { against, counted, exempt, keyOf, markedRegions, movedIn, pruned, type Copy } from './rules.js';

const FRAGMENT = 'export function total(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}';

const copy = (a: string, b: string, fragment = FRAGMENT, at = 1): Copy => ({ scope: 'src', a: { file: a, start: at, end: at + 2 }, b: { file: b, start: at, end: at + 2 }, fragment });

describe('the key', () => {
  it('names the pair of files in order and a hash of the tokens, never the lines', () => {
    expect(keyOf(copy('b.ts', 'a.ts'))).toBe(keyOf(copy('a.ts', 'b.ts', FRAGMENT, 40)));
    expect(keyOf(copy('a.ts', 'b.ts'))).toMatch(/^src a\.ts <-> b\.ts #[0-9a-f]{12}$/);
  });

  it('holds when only the spacing changes, and changes with the tokens', () => {
    expect(keyOf(copy('a.ts', 'b.ts', FRAGMENT.replace(/\n {2}/g, '\n    ')))).toBe(keyOf(copy('a.ts', 'b.ts')));
    expect(keyOf(copy('a.ts', 'b.ts', FRAGMENT.replace('sum + item', 'sum - item')))).not.toBe(keyOf(copy('a.ts', 'b.ts')));
  });
});

describe('the baseline', () => {
  const today = [copy('a.ts', 'b.ts'), copy('c.ts', 'd.ts', 'other()')];
  const baseline = counted(today);

  it('lets through exactly what it holds', () => {
    expect(against(today, baseline)).toEqual({ added: [], fixed: [] });
  });

  it('fails a copy it does not hold, and a second of one it holds once', () => {
    const second = copy('a.ts', 'b.ts', FRAGMENT, 30);
    const fresh = copy('a.ts', 'e.ts');
    expect(against([...today, second, fresh], baseline).added).toEqual([second, fresh]);
  });

  it('names a fixed copy, and pruning drops it and never adds what is new', () => {
    const better = [today[0]!];
    expect(against(better, baseline).fixed).toEqual([{ key: keyOf(today[1]!), was: 1, now: 0 }]);
    expect(pruned(baseline, [...better, copy('x.ts', 'y.ts')])).toEqual(counted(better));
  });

  it('carries a copy whose file moved, keeping the side that stayed and the same tokens', () => {
    const moved = copy('a.ts', 'renamed.ts');
    const carried = movedIn(baseline, [moved, today[1]!]);
    expect(carried.moves).toEqual([{ from: keyOf(today[0]!), to: keyOf(moved), count: 1 }]);
    expect(against([moved, today[1]!], carried.baseline)).toEqual({ added: [], fixed: [] });
  });

  it('carries nothing whose tokens changed or whose both files are new', () => {
    expect(movedIn(baseline, [copy('a.ts', 'renamed.ts', 'changed()'), today[1]!]).moves).toEqual([]);
    expect(movedIn(baseline, [copy('p.ts', 'q.ts'), today[1]!]).moves).toEqual([]);
  });
});

describe('the marker', () => {
  const marked = [
    'import { thing } from \'./thing.js\';',
    '',
    '/**',
    ' * ── DUPLICATED, KNOWINGLY ──',
    ' * Authority: `Total` in apps/backend/src/sums.ts.',
    ' */',
    'export interface Total { sum: number }',
    'export const zero: Total = { sum: 0 };',
    '',
    '/** Not marked. */',
    'export const one = 1;',
  ].join('\n');

  it('covers the declarations under it up to the next one with a comment of its own', () => {
    expect(markedRegions(marked, 'f.ts')).toEqual([{ from: 7, to: 8, authority: expect.stringContaining('apps/backend/src/sums.ts') }]);
  });

  it('reads a one-line marker naming its authority', () => {
    const text = 'const a = 1;\n// ── DUPLICATED, KNOWINGLY ── packages/x/src/y.ts wins.\nconst b = 2;\n';
    expect(markedRegions(text, 'f.ts')).toEqual([{ from: 3, to: 3, authority: expect.stringContaining('packages/x/src/y.ts') }]);
  });

  it('exempts a copy inside a marked region only when its authority names the other file', () => {
    const regions = (file: string) => (file === 'apps/frontend/src/sums.ts' ? markedRegions(marked, file) : []);
    const inside = (other: string): Copy => ({ scope: 'src', a: { file: 'apps/frontend/src/sums.ts', start: 7, end: 8 }, b: { file: other, start: 1, end: 2 }, fragment: 'x' });
    expect(exempt(inside('apps/backend/src/sums.ts'), regions)).toBe(true);
    expect(exempt(inside('apps/backend/src/other.ts'), regions)).toBe(false);
    expect(exempt({ ...inside('apps/backend/src/sums.ts'), a: { file: 'apps/frontend/src/sums.ts', start: 7, end: 11 } }, regions)).toBe(false);
  });
});
