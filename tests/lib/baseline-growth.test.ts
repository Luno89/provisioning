import { describe, expect, it } from 'vitest';
import { grown } from './baseline-growth.js';

describe('a baseline that may only shrink', () => {
  it('lets a commit through that fixes entries or carries one to its new name, keeping each rule\'s total', () => {
    const before = { 'R1 a.ts#x -> b.ts#y (call)': 2, 'R2 a.ts#x -> c.ts#z (call)': 1 };
    expect(grown(before, { 'R1 a.ts#x -> b.ts#y (call)': 1, 'R2 a.ts#x -> c.ts#z (call)': 1 })).toEqual([]);
    expect(grown(before, { 'R1 moved.ts#x -> b.ts#y (call)': 2, 'R2 a.ts#x -> c.ts#z (call)': 1 })).toEqual([]);
    expect(grown(before, {})).toEqual([]);
  });

  it('names each rule whose total grew, with how much, so the gap that was added is plain', () => {
    const before = { 'R1 a.ts#x -> b.ts#y (call)': 1, 'src a.ts <-> b.ts #1': 3 };
    const after = { 'R1 a.ts#x -> b.ts#y (call)': 1, 'R1 new.ts#n -> b.ts#y (call)': 2, 'src a.ts <-> b.ts #1': 3, 'tests t.ts <-> u.ts #2': 1 };
    expect(grown(before, after)).toEqual(['R1 grew from 1 to 3', 'tests grew from 0 to 1']);
  });
});
