import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

const SRC = join(import.meta.dirname, '..');
const ALLOWED = new Set(['tree-type-seeds.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') sourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('where a project type may be named', () => {
  it('names every type id in exactly one file', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (ALLOWED.has(file.split('/').pop()!)) continue;
      const text = readFileSync(file, 'utf8');
      for (const seed of TREE_TYPE_SEEDS) {
        const id = seed.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const branches = new RegExp(
          `(===\\s*['"]${id}['"])`
          + `|(['"]${id}['"]\\s*===)`
          + `|(case\\s+['"]${id}['"])`
          + `|(type\\s*:\\s*['"]${id}['"])`
          + `|(includes\\(\\s*['"]${id}['"])`,
        );
        if (branches.test(text)) {
          offenders.push(`${file.replace(SRC, 'src')} branches on '${seed.id}'`);
        }
      }
    }

    expect(offenders, 'a project type is data; code must resolve it, not name it').toEqual([]);
  });
});
