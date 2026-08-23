import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

/**
 * ── ONE PLACE, ENFORCED ──
 *
 * `TREE_TYPES` carried its own argument: "A registry rather than a boolean or a set of
 * `if (type === 'x')` predicates scattered around. This codebase already learned that with cluster
 * providers: adding one used to mean twenty greps."
 *
 * A registry only holds if nothing else names its members. This walks the source and fails if a
 * type id appears anywhere outside the seed file — the same shape as the registry-versus-schema
 * bijection test in `koala-chat.test.ts`, and for the same reason: a rule nothing checks is a rule
 * that decays the first time somebody is in a hurry.
 */

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
        /**
         * Looks for BRANCHING, not for the word.
         *
         * Type ids are ordinary words — `library` is also a README kind and a storage bucket — so a
         * bare substring search flags things that have nothing to do with project types. What
         * couples code to a type is comparing against it, switching on it, or looking it up: those
         * are the shapes that make adding a type mean editing code.
         */
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
