import { describe, expect, it } from 'vitest';
import { DECISIONS } from '../alignment/decisions.js';
import { flattenSuppressions, grants, grown, grownTotal, STAGED, SUPPRESSION_FILES } from './baseline-growth.js';

describe('a baseline that may only shrink', () => {
  it('lets a commit through that fixes entries or carries one to its new name, keeping each rule\'s total', () => {
    const before = { 'R1 a.ts#x -> b.ts#y (call)': 2, 'R2 a.ts#x -> c.ts#z (call)': 1 };
    expect(grown('p', before, { 'R1 a.ts#x -> b.ts#y (call)': 1, 'R2 a.ts#x -> c.ts#z (call)': 1 }, [])).toEqual([]);
    expect(grown('p', before, { 'R1 moved.ts#x -> b.ts#y (call)': 2, 'R2 a.ts#x -> c.ts#z (call)': 1 }, [])).toEqual([]);
    expect(grown('p', before, {}, [])).toEqual([]);
  });

  it('judges the untested list by its whole count, so a function that moves files keeps it level and one more untested function grows it', () => {
    const before = { 'a.ts#save': 1, 'b.ts#load': 2 };
    expect(grownTotal(before, { 'moved.ts#save': 1, 'b.ts#load': 2 })).toEqual([]);
    expect(grownTotal(before, { 'a.ts#save': 1, 'b.ts#load': 2, 'c.ts#new': 1 })).toEqual(['grew from 3 to 4']);
    expect(STAGED.map((baseline) => baseline.path)).toContain('tests/coupling/untested.json');
  });

  it('names each rule whose total grew, with how much, so the gap that was added is plain', () => {
    const before = { 'R1 a.ts#x -> b.ts#y (call)': 1, 'src a.ts <-> b.ts #1': 3 };
    const after = { 'R1 a.ts#x -> b.ts#y (call)': 1, 'R1 new.ts#n -> b.ts#y (call)': 2, 'src a.ts <-> b.ts #1': 3, 'tests t.ts <-> u.ts #2': 1 };
    expect(grown('p', before, after, [])).toEqual(['R1 grew from 1 to 3', 'tests grew from 0 to 1']);
  });

  it('holds every workspace\'s ESLint suppressions to the same rule, a count per rule that may not rise', () => {
    const before = flattenSuppressions({ 'src/a.ts': { 'no-restricted-syntax': { count: 2 } } });
    const after = flattenSuppressions({ 'src/a.ts': { 'no-restricted-syntax': { count: 3 } }, 'src/b.ts': { 'failures/no-warn-and-carry-on': { count: 1 } } });
    expect(grown('p', before, after, [])).toEqual(['no-restricted-syntax grew from 2 to 3', 'failures/no-warn-and-carry-on grew from 0 to 1']);
    expect(grown('p', before, flattenSuppressions({}), [])).toEqual([]);
    expect(STAGED.map((baseline) => baseline.path)).toEqual(expect.arrayContaining(SUPPRESSION_FILES));
  });

  it('lets a rule grow only from the count and up to the count a yes in the decisions register names, once', () => {
    const yes = [{ path: 'a/eslint-suppressions.json', rule: 'R1', from: 0, to: 3 }];
    const before = { 'R1 x.ts': 0 };
    expect(grown('a/eslint-suppressions.json', {}, { 'R1 x.ts': 2, 'R1 y.ts': 1 }, yes)).toEqual([]);
    expect(grown('a/eslint-suppressions.json', {}, { 'R1 x.ts': 4 }, yes)).toEqual(['R1 grew from 0 to 4, past the 3 the register allows']);
    expect(grown('b/eslint-suppressions.json', before, { 'R1 x.ts': 1 }, yes)).toEqual(['R1 grew from 0 to 1']);
    expect(grown('a/eslint-suppressions.json', { 'R1 x.ts': 2 }, { 'R1 x.ts': 3 }, yes)).toEqual(['R1 grew from 2 to 3']);
  });

  it('reads the yeses from the register, each naming a baseline that is held', () => {
    const named = grants(DECISIONS);
    expect(named.length).toBeGreaterThan(0);
    for (const grant of named) expect(STAGED.map((baseline) => baseline.path)).toContain(grant.path);
  });
});
