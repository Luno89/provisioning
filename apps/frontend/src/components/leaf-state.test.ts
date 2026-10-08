import { describe, it, expect } from 'vitest';
import { stateFor, blockedBy, BOARD_COLUMNS, STATE_LABEL, landingNote, leafDocuments, type LeafStatus } from './leaf-types.js';

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

describe('a leaf\'s documents', () => {
  it('are the files its claim recorded, each read at the commit it claimed', () => {
    expect(leafDocuments({ claim: { evidence: 'x', at: 'now', commit: 'c0ffee', files: ['src/a.ts', 'notes.md'] } }, 't1')).toEqual([
      { workspace: 'tree-t1', path: 'src/a.ts', at: 'c0ffee' },
      { workspace: 'tree-t1', path: 'notes.md', at: 'c0ffee' },
    ]);
  });

  it('are none before a claim, or when the claim has no commit', () => {
    expect(leafDocuments({}, 't1')).toEqual([]);
    expect(leafDocuments({ claim: { evidence: 'x', at: 'now', files: ['a.md'] } }, 't1')).toEqual([]);
  });
});

describe('whether a leaf\'s work is on main', () => {
  it('says a verified leaf lands at the end of the pass, and a landed one is on main', () => {
    expect(landingNote({ status: 'succeeded', verified: true })).toBe('Verified — lands on main at the end of this judge pass');
    expect(landingNote({ status: 'succeeded', verified: true, landed: { at: 'now', outcome: 'merged' } })).toBe('Landed on main');
    expect(landingNote({ status: 'running' })).toBeUndefined();
  });
});
