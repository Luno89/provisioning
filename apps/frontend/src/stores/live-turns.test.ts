import { describe, it, expect, beforeEach } from 'vitest';
import { useLiveTurnsStore, branchTurnKey } from './live-turns.js';

const key = branchTurnKey('b1');

beforeEach(() => {
  useLiveTurnsStore.setState({ turns: {} });
});

describe('appendBranchDelta — overthink warning', () => {
  it('carries the warning onto the branch turn once set', () => {
    useLiveTurnsStore.getState().startBranch(key);
    useLiveTurnsStore.getState().appendBranchDelta(key, { content: 'a', overthinkWarning: 'looping' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.kind).toBe('branch');
    expect(turn?.kind === 'branch' && turn.overthinkWarning).toBe('looping');
  });

  it('keeps the warning across later deltas that carry none of their own', () => {
    useLiveTurnsStore.getState().startBranch(key);
    useLiveTurnsStore.getState().appendBranchDelta(key, { content: 'a', overthinkWarning: 'looping' });
    useLiveTurnsStore.getState().appendBranchDelta(key, { content: 'b' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.kind === 'branch' && turn.overthinkWarning).toBe('looping');
    expect(turn?.kind === 'branch' && turn.trailing.content).toBe('ab');
  });

  it('does not set a warning when none was ever sent', () => {
    useLiveTurnsStore.getState().startBranch(key);
    useLiveTurnsStore.getState().appendBranchDelta(key, { content: 'a' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.kind === 'branch' && turn.overthinkWarning).toBeUndefined();
  });
});
