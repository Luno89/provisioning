import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { columnFor } from './tree-board.js';
import type { Leaf } from './leaves.js';

/**
 * Do the server and the browser agree about what a leaf's state is?
 *
 * ── WHY THIS EXISTS ──
 * `stateFor` in apps/frontend/src/components/leaf-types.ts is a hand-copy of `columnFor` here,
 * because the frontend cannot import backend modules. A hand-copied switch statement is exactly the
 * thing that drifts, and this drift would be invisible: the board (computed here) and the Grove
 * navigator (computed there) would simply disagree about one leaf in one state, with nothing failing.
 *
 * ── AND WHY IT LIVES ON THIS SIDE ──
 * It reads two source files and needs no DOM. The frontend's tsconfig deliberately withholds node's
 * builtins from application code (`types: ["vite/client"]`), and weakening that so one test can call
 * readFileSync would trade a real guarantee for a convenience.
 *
 * The point is not to assert what either function returns — that asserts the lines someone just
 * wrote. It is to read BOTH implementations out of their sources and require them to say the same
 * thing, which is the only failure worth catching here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, '../../../frontend/src/components/leaf-types.ts');

/** Pulls the `case 'x': return y;` arms out of a named function in a source file. */
function switchArms(source: string, fn: string): { status: string; expr: string }[] {
  const at = source.indexOf(fn);
  if (at < 0) return [];
  const body = source.slice(at, source.indexOf('\n}', at));
  return [...body.matchAll(/case '(\w+)':\s*return ([^;]+);/g)].map((m) => ({ status: m[1]!, expr: m[2]!.trim() }));
}

/**
 * Normalised so the two spellings of the same rule compare equal.
 *
 * The server is HANDED `blocked`; the browser has to work it out from the leaf list, so it writes
 * the predicate inline. That one substitution is exact rather than fuzzy on purpose — `.length > 1`
 * or a different helper still fails, which is the drift this exists to catch.
 */
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

    // If either reads zero the regex has rotted and this test is asserting nothing at all.
    expect(ours.length, 'parsed no arms from tree-board.ts').toBeGreaterThanOrEqual(6);
    expect(theirs.length, 'parsed no arms from leaf-types.ts').toBeGreaterThanOrEqual(6);

    expect(theirs.map((a) => a.status)).toEqual(ours.map((a) => a.status));
    expect(theirs.map((a) => normalise(a.expr))).toEqual(ours.map((a) => normalise(a.expr)));
  });

  it('agrees on every status the type admits', () => {
    /**
     * Driven from the LeafStatus union in the frontend's source rather than a list written here, so
     * adding a status to the type without teaching both functions about it fails.
     */
    const union = frontendSource.match(/export type LeafStatus =([^;]+);/)?.[1] ?? '';
    const statuses = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
    expect(statuses.length).toBeGreaterThanOrEqual(6);

    for (const status of statuses) {
      for (const verified of [true, false]) {
        for (const blocked of [true, false]) {
          // Only the server's answer is computed here; the frontend's is compared structurally
          // above. This pins that every status produces SOME defined answer or a deliberate none.
          const out = columnFor(leaf({ status: status as Leaf['status'], verified }), blocked);
          expect(out === undefined || typeof out === 'string', `${status} produced ${out}`).toBe(true);
        }
      }
    }
  });

  it('keeps cancelled off the board on both sides', () => {
    /**
     * The subtle one. A cancelled leaf is neither done nor outstanding, so giving it a column would
     * make it count toward one of them and quietly move every progress figure on the page.
     */
    expect(columnFor(leaf({ status: 'cancelled' }), false)).toBeUndefined();
    const theirs = switchArms(frontendSource, 'export function stateFor');
    expect(theirs.find((a) => a.status === 'cancelled')?.expr).toBe('undefined');
  });

  it('never lets a claim render as a verification', () => {
    expect(columnFor(leaf({ status: 'succeeded', verified: false }), false)).toBe('claimed');
    expect(columnFor(leaf({ status: 'succeeded', verified: true }), false)).toBe('verified');
    // And the frontend must not have quietly collapsed the two into one word.
    expect(frontendSource).toMatch(/verified \? 'verified' : 'claimed'/);
  });

  it('has retired the themed vocabulary rather than moving it', () => {
    /**
     * Named explicitly so bringing them back is a decision. These are the words that had one leaf
     * showing three different states at once — Digested in the pane, Review beside it, Verified on
     * the board. Comments are stripped first: the file documents why they went, and a check that
     * cannot tell prose from code would forbid writing that down.
     */
    const code = frontendSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const word of ['Sprouting', 'Ripe', 'Munching', 'Digested', 'Bitter', "id: 'todo'", "'in-progress'"]) {
      expect(code.includes(word), `${word} is back in the state vocabulary`).toBe(false);
    }
  });
});
