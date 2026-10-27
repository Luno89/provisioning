import { describe, expect, it } from 'vitest';
import { firstMatch, linearPattern } from './linear-patterns.js';
import { BUILT_IN_SCENARIOS } from '../../eval/level2/scenarios.js';

function patternsIn(value: unknown, under: string | undefined, found: string[]): string[] {
  if (typeof value === 'string') {
    if (under === 'matches' || under === 'contentPattern' || under === 'when.asked' || under === 'when.system' || under === 'when.said') found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) patternsIn(item, under, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) patternsIn(item, under === 'when' ? `when.${key}` : key, found);
  }
  return found;
}

describe('patterns written by a model, the memory keeper or a person', () => {
  it('finish in time linear in what they read, where a backtracking engine would never come back', () => {
    const text = `${'a'.repeat(50_000)}!`;
    const started = Date.now();
    expect(linearPattern('^(a+)+$', { multiline: true }).test(text)).toBe(false);
    expect(linearPattern('(a|aa)*b').test(text)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keep the flags and capture groups the checks use', () => {
    expect(linearPattern('^version = "2"$', { multiline: true }).test('name = "x"\nversion = "2"\n')).toBe(true);
    expect(linearPattern('a.b', { dotAll: true }).test('a\nb')).toBe(true);
    expect(linearPattern('a.b').test('a\nb')).toBe(false);
    expect(linearPattern('koala', { ignoreCase: true }).test('KOALA')).toBe(true);
    expect(firstMatch(linearPattern('call (\\w+) with (\\d+)?'), 'please call report with now')).toEqual(['call report with ', 'report', undefined]);
    expect(firstMatch(linearPattern('nothing'), 'here')).toBeNull();
  });

  it('refuse lookarounds and backreferences rather than running them', () => {
    expect(() => linearPattern('(?=a)a')).toThrow();
    expect(() => linearPattern('(a)\\1')).toThrow();
  });

  it('cover every pattern a shipped check carries', () => {
    const patterns = patternsIn(BUILT_IN_SCENARIOS, undefined, []);
    expect(patterns.length).toBeGreaterThan(20);
    const refused = patterns.filter((pattern) => { try { linearPattern(pattern); return false; } catch { return true; } });
    expect(refused).toEqual([]);
  });
});
