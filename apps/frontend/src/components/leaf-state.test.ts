import { describe, it, expect } from 'vitest';
import { stateFor, blockedBy, BOARD_COLUMNS, STATE_LABEL, type LeafStatus } from './leaf-types.js';

const leaf = (over: Partial<{ status: LeafStatus; verified: boolean; dependsOn: string[] }>) =>
  ({ status: 'pending' as LeafStatus, ...over });

describe('the server and the UI naming the same state', () => {
  it('counts a dependency as met only when it succeeded', () => {
    const failed = [{ id: 'd', status: 'failed' as LeafStatus }];
    expect(blockedBy({ dependsOn: ['d'] }, failed)).toHaveLength(1);
    expect(stateFor(leaf({ status: 'pending', dependsOn: ['d'] }), failed)).toBe('blocked');

    const done = [{ id: 'd', status: 'succeeded' as LeafStatus }];
    expect(blockedBy({ dependsOn: ['d'] }, done)).toHaveLength(0);
  });

  it('ignores a dependency that no longer exists', () => {
    expect(blockedBy({ dependsOn: ['gone'] }, [])).toHaveLength(0);
  });

  it('keeps claimed and verified as different words', () => {
    expect(STATE_LABEL.claimed).not.toBe(STATE_LABEL.verified);
    expect(stateFor(leaf({ status: 'succeeded', verified: false }), [])).toBe('claimed');
    expect(stateFor(leaf({ status: 'succeeded', verified: true }), [])).toBe('verified');
  });

  it('has a label for every column and no orphans', () => {
    expect(Object.keys(STATE_LABEL).sort()).toEqual(BOARD_COLUMNS.map((c) => c.id).sort());
  });

});
