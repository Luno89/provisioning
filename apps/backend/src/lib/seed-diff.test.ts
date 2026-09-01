import { describe, it, expect } from 'vitest';
import { sameSeededRow } from './seed-diff.js';

describe('sameSeededRow', () => {
  it('ignores the timestamps, which is the whole point', () => {
    expect(sameSeededRow(
      { id: 'a', name: 'Koala', createdAt: '2020-01-01', updatedAt: '2020-01-01' },
      { id: 'a', name: 'Koala', createdAt: '2026-08-31', updatedAt: '2026-08-31' },
    )).toBe(true);
  });

  it('does not care what order the keys came back in', () => {
    expect(sameSeededRow({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('sees a changed value', () => {
    expect(sameSeededRow({ id: 'a', name: 'Koala' }, { id: 'a', name: 'Renamed' })).toBe(false);
  });

  it('sees an added or removed field', () => {
    expect(sameSeededRow({ id: 'a' }, { id: 'a', extra: 1 })).toBe(false);
    expect(sameSeededRow({ id: 'a', extra: 1 }, { id: 'a' })).toBe(false);
  });

  it('treats an absent field and an explicit undefined as the same', () => {
    // `exactOptionalPropertyTypes` means seeds spread fields in conditionally; a row read back
    // from Mongo simply lacks them.
    expect(sameSeededRow({ id: 'a' }, { id: 'a', mcp: undefined })).toBe(true);
  });

  it('compares nested config, which is where a pack actually differs', () => {
    expect(sameSeededRow(
      { sampling: { conversation: { temperature: 0.3 } } },
      { sampling: { conversation: { temperature: 0.7 } } },
    )).toBe(false);
    expect(sameSeededRow(
      { sampling: { conversation: { temperature: 0.3 } } },
      { sampling: { conversation: { temperature: 0.3 } } },
    )).toBe(true);
  });

  it('compares arrays by order, since a tool list is ordered', () => {
    expect(sameSeededRow({ tools: ['a', 'b'] }, { tools: ['b', 'a'] })).toBe(false);
    expect(sameSeededRow({ tools: ['a', 'b'] }, { tools: ['a', 'b'] })).toBe(true);
  });
});
