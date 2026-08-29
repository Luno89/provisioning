import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { columnFor } from './tree-board.js';
import type { Leaf } from './leaves.js';

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, '../../../frontend/src/components/leaf-types.ts');

function switchArms(source: string, fn: string): { status: string; expr: string }[] {
  const at = source.indexOf(fn);
  if (at < 0) return [];
  const body = source.slice(at, source.indexOf('\n}', at));
  return [...body.matchAll(/case '(\w+)':\s*return ([^;]+);/g)].map((m) => ({ status: m[1]!, expr: m[2]!.trim() }));
}

const normalise = (expr: string) => expr
  .replace(/blockedBy\(leaf, all\)\.length > 0/g, 'blocked')
  .replace(/\bleaf[?.]*\./g, '')
  .replace(/\s+/g, ' ')
  .trim();

const leaf = (over: Partial<Leaf>) => ({ id: 'l', status: 'pending', ...over } as Leaf);

describe('the board rule, on both sides of the wire', () => {
  const frontendSource = readFileSync(FRONTEND, 'utf8');

  it('has the same arms in the same order', () => {
    const ours = switchArms(readFileSync(join(here, 'tree-board.ts'), 'utf8'), 'export function columnFor');
    const theirs = switchArms(frontendSource, 'export function stateFor');

    expect(ours.length, 'parsed no arms from tree-board.ts').toBeGreaterThanOrEqual(6);
    expect(theirs.length, 'parsed no arms from leaf-types.ts').toBeGreaterThanOrEqual(6);

    expect(theirs.map((a) => a.status)).toEqual(ours.map((a) => a.status));
    expect(theirs.map((a) => normalise(a.expr))).toEqual(ours.map((a) => normalise(a.expr)));
  });

  it('agrees on every status the type admits', () => {
    const union = frontendSource.match(/export type LeafStatus =([^;]+);/)?.[1] ?? '';
    const statuses = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
    expect(statuses.length).toBeGreaterThanOrEqual(6);

    for (const status of statuses) {
      for (const verified of [true, false]) {
        for (const blocked of [true, false]) {
          const out = columnFor(leaf({ status: status as Leaf['status'], verified }), blocked);
          expect(out === undefined || typeof out === 'string', `${status} produced ${out}`).toBe(true);
        }
      }
    }
  });

  it('keeps cancelled off the board on both sides', () => {
    expect(columnFor(leaf({ status: 'cancelled' }), false)).toBeUndefined();
    const theirs = switchArms(frontendSource, 'export function stateFor');
    expect(theirs.find((a) => a.status === 'cancelled')?.expr).toBe('undefined');
  });

  it('never lets a claim render as a verification', () => {
    expect(columnFor(leaf({ status: 'succeeded', verified: false }), false)).toBe('claimed');
    expect(columnFor(leaf({ status: 'succeeded', verified: true }), false)).toBe('verified');
    expect(frontendSource).toMatch(/verified \? 'verified' : 'claimed'/);
  });

  it('reads the usage field the server actually writes', () => {
    const record = readFileSync(join(here, 'leaves.ts'), 'utf8');
    const declares = (src: string, field: string) => new RegExp(`^\\s*${field}\\?:`, 'm').test(src);

    expect(declares(record, 'usage'), 'the server stopped declaring `usage`').toBe(true);
    expect(declares(record, 'usageTotal')).toBe(false);
    expect(declares(frontendSource, 'usage')).toBe(true);

    const route = readFileSync(join(here, '..', 'routes', 'leaves.ts'), 'utf8');
    const emitsRollup = route.includes('usageTotal: aggregateUsage(');
    expect(emitsRollup, 'the leaves route stopped emitting the subtree rollup').toBe(true);
    expect(frontendSource.includes('usageTotal?:')).toBe(emitsRollup);
  });

  it('agrees on when a run is over', () => {
    const ours = readFileSync(join(here, 'branch-settlement.ts'), 'utf8');
    const theirs = readFileSync(join(here, '../../../frontend/src/components/home-summary.ts'), 'utf8');

    const statuses = (src: string, decl: string) => {
      const at = src.indexOf(decl);
      expect(at, `could not find ${decl} — the mirror check is not running`).toBeGreaterThan(-1);
      return [...src.slice(at, src.indexOf(']', at)).matchAll(/'(\w+)'/g)].map((m) => m[1]!).sort();
    };

    expect(statuses(theirs, 'const LIVE_STATUS = new Set([')).toEqual(statuses(ours, 'const LIVE = new Set(['));
  });

  it('has retired the themed vocabulary rather than moving it', () => {
    const code = frontendSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const word of ['Sprouting', 'Ripe', 'Munching', 'Digested', 'Bitter', "id: 'todo'", "'in-progress'"]) {
      expect(code.includes(word), `${word} is back in the state vocabulary`).toBe(false);
    }
  });
});
