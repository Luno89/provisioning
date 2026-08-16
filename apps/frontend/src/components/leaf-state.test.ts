import { describe, it, expect } from 'vitest';
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
 * The reflective half of this — parsing the server's switch arms out of its source and requiring
 * this side to reproduce them — lives in the BACKEND suite, as lib/tree-board-mirror.test.ts. It
 * reads two files and needs no DOM, and this project's tsconfig deliberately withholds node's
 * builtins from application code. What stays here is the behaviour a component depends on.
 */

const leaf = (over: Partial<{ status: LeafStatus; verified: boolean; dependsOn: string[] }>) =>
  ({ status: 'pending' as LeafStatus, ...over });

describe('the server and the UI naming the same state', () => {
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

});
