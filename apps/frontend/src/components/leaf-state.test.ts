import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stateFor, blockedBy, BOARD_COLUMNS, STATE_LABEL, type LeafStatus } from './leaf-types.js';

/**
 * Does the UI agree with the server about what a leaf's state is?
 *
 * ── WHY THIS EXISTS ──
 * `stateFor` here is a hand-copy of `columnFor` in apps/backend/src/lib/tree-board.ts, because the
 * frontend cannot import backend modules. A hand-copy of a switch statement is exactly the thing
 * that drifts, and the drift is invisible: the board (server-computed) and the navigator
 * (client-computed) would simply disagree about one leaf, in one state, and nothing would fail.
 *
 * So the important test here is not "does stateFor map succeeded+verified to verified" — that
 * asserts the line I just wrote. It is the reflective one: read the server's switch arms out of its
 * SOURCE and require this side to reproduce them. That fails when someone changes the rule on
 * either side, which is the only failure worth catching.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(here, '../../../backend/src/lib/tree-board.ts');

const leaf = (over: Partial<{ status: LeafStatus; verified: boolean; dependsOn: string[] }>) =>
  ({ status: 'pending' as LeafStatus, ...over });

describe('the server and the UI naming the same state', () => {
  it('reproduces every arm of the backend switch', () => {
    /**
     * Parsed from the source rather than restated, so a new status — or a changed mapping — fails
     * here instead of quietly producing two different boards.
     */
    const src = readFileSync(BACKEND, 'utf8');
    const body = src.slice(src.indexOf('export function columnFor'), src.indexOf('\n}', src.indexOf('export function columnFor')));
    const arms = [...body.matchAll(/case '(\w+)':\s*return ([^;]+);/g)].map((m) => ({ status: m[1]!, expr: m[2]!.trim() }));

    // If this ever reads zero arms the regex has rotted and the test is asserting nothing.
    expect(arms.length, 'parsed no switch arms from tree-board.ts — the mirror check is not running').toBeGreaterThanOrEqual(6);

    for (const arm of arms) {
      const status = arm.status as LeafStatus;

      if (arm.expr === 'undefined') {
        expect(stateFor(leaf({ status }), []), `${status} must be off-board on both sides`).toBeUndefined();
        continue;
      }

      // `blocked ? 'blocked' : 'proposed'` — check BOTH sides of the server's conditional.
      if (arm.expr.includes('blocked ?')) {
        const dep = { id: 'd', status: 'running' as LeafStatus };
        expect(stateFor(leaf({ status, dependsOn: ['d'] }), [dep])).toBe('blocked');
        expect(stateFor(leaf({ status }), [])).toBe('proposed');
        continue;
      }

      // `leaf.verified ? 'verified' : 'claimed'`
      if (arm.expr.includes('verified ?')) {
        expect(stateFor(leaf({ status, verified: true }), [])).toBe('verified');
        expect(stateFor(leaf({ status, verified: false }), [])).toBe('claimed');
        continue;
      }

      const plain = arm.expr.replace(/'/g, '');
      expect(stateFor(leaf({ status }), []), `${status} should map to ${plain}`).toBe(plain);
    }
  });

  it('counts a dependency as met only when it succeeded', () => {
    /**
     * The one rule with a real edge: a dependency that FAILED does not unblock its dependent. An
     * `!== 'pending'` style check would call it met and start work whose input never arrived.
     */
    const failed = [{ id: 'd', status: 'failed' as LeafStatus }];
    expect(blockedBy({ dependsOn: ['d'] }, failed)).toHaveLength(1);
    expect(stateFor(leaf({ status: 'pending', dependsOn: ['d'] }), failed)).toBe('blocked');

    const done = [{ id: 'd', status: 'succeeded' as LeafStatus }];
    expect(blockedBy({ dependsOn: ['d'] }, done)).toHaveLength(0);
  });

  it('ignores a dependency that no longer exists', () => {
    // A deleted dependency must not block forever — there is nothing left to wait for.
    expect(blockedBy({ dependsOn: ['gone'] }, [])).toHaveLength(0);
  });

  it('keeps claimed and verified as different words', () => {
    /**
     * The distinction the whole vocabulary exists for. If these ever render the same, a model's
     * report on its own work has been laundered into a checked fact at the point a person looks.
     */
    expect(STATE_LABEL.claimed).not.toBe(STATE_LABEL.verified);
    expect(stateFor(leaf({ status: 'succeeded', verified: false }), [])).toBe('claimed');
    expect(stateFor(leaf({ status: 'succeeded', verified: true }), [])).toBe('verified');
  });

  it('has a label for every column and no orphans', () => {
    expect(Object.keys(STATE_LABEL).sort()).toEqual(BOARD_COLUMNS.map((c) => c.id).sort());
  });

  it('no longer speaks the themed vocabulary', () => {
    /**
     * Named explicitly so re-adding them is a decision rather than an accident. These were the words
     * that made one leaf show three states at once.
     */
    // Comments stripped first: the file DOCUMENTS the deleted words to explain why they went, and
    // a check that cannot tell prose from code would forbid writing that down.
    const code = readFileSync(join(here, 'leaf-types.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const word of ['Sprouting', 'Munching', 'Digested', 'Bitter', "id: 'todo'", "'in-progress'"]) {
      expect(code.includes(word), `${word} is back in the state vocabulary`).toBe(false);
    }
  });
});
