import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryModelsStore } from '../testing/memory-store.js';
import { seedToolCallParsers } from './tool-call-parser-seed.js';

const seedFile = (seed: unknown): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'parsers-')), 'tool-call-parsers.json');
  writeFileSync(file, JSON.stringify(seed));
  return file;
};

describe('seeding the tool call parsers', () => {
  it('writes the shipped ones into the store, then nothing while they stay as shipped', async () => {
    const store = new MemoryModelsStore();
    const file = seedFile({ parsers: [{ parser: 'hermes', label: 'Hermes', template: [{ contains: '<tool_call>' }] }, { parser: 'hf', label: 'Its own' }] });
    expect(await seedToolCallParsers(store, file)).toBe(2);
    expect(await store.getToolCallParsers()).toEqual([
      { parser: 'hermes', label: 'Hermes', template: [{ contains: '<tool_call>' }], names: [], shipped: true },
      { parser: 'hf', label: 'Its own', template: [], names: [], shipped: true },
    ]);
    expect(await seedToolCallParsers(store, file)).toBe(0);
  });

  it('stops start, naming what is wrong, when the file cannot be read', async () => {
    const store = new MemoryModelsStore();
    await expect(seedToolCallParsers(store, seedFile({ parsers: [{ parser: 'a' }] }))).rejects.toThrow('The tool call parsers to seed cannot be read: a: it has no label');
    expect(await store.getToolCallParsers()).toEqual([]);
  });
});
