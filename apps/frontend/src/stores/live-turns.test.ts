import { describe, it, expect, beforeEach } from 'vitest';
import { useLiveTurnsStore, branchTurnKey, conversationTurnKey } from './live-turns.js';

const key = branchTurnKey('b1');

beforeEach(() => {
  useLiveTurnsStore.setState({ turns: {} });
});

describe('start / applyFrame / finish', () => {
  it('accumulates content and thinking deltas from unified frames', () => {
    useLiveTurnsStore.getState().start(key);
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'Hello ' });
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'world' });
    useLiveTurnsStore.getState().applyFrame(key, { type: 'thinking', delta: 'thinking...' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.status).toBe('streaming');
    expect(turn?.renderState.live).toBe('Hello world');
    expect(turn?.renderState.liveThinking).toBe('thinking...');
  });

  it('works identically for a conversation-keyed turn — same store, same mechanics', () => {
    const convKey = conversationTurnKey('c1');
    useLiveTurnsStore.getState().start(convKey);
    useLiveTurnsStore.getState().applyFrame(convKey, { type: 'content', delta: 'hi' });

    expect(useLiveTurnsStore.getState().turns[convKey]?.renderState.live).toBe('hi');
    expect(useLiveTurnsStore.getState().turns[key]).toBeUndefined();
  });

  it('carries an overthink warning onto the turn once set', () => {
    useLiveTurnsStore.getState().start(key);
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'a' });
    useLiveTurnsStore.getState().applyFrame(key, { type: 'overthinkWarning', payload: 'looping' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.renderState.overthinkWarning).toBe('looping');
  });

  it('keeps the warning across later deltas that carry none of their own', () => {
    useLiveTurnsStore.getState().start(key);
    useLiveTurnsStore.getState().applyFrame(key, { type: 'overthinkWarning', payload: 'looping' });
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'b' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.renderState.overthinkWarning).toBe('looping');
    expect(turn?.renderState.live).toBe('b');
  });

  it('does not set a warning when none was ever sent', () => {
    useLiveTurnsStore.getState().start(key);
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'a' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.renderState.overthinkWarning).toBeUndefined();
  });

  it('records an interrupted reason from an "interrupted" wire frame', () => {
    useLiveTurnsStore.getState().start(key);
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'partial' });
    useLiveTurnsStore.getState().applyFrame(key, { type: 'interrupted', payload: 'Overthinking loop detected' });

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.renderState.interruptedReason).toBe('Overthinking loop detected');
  });

  it('finish sets the status without touching the accumulated render state', () => {
    useLiveTurnsStore.getState().start(key);
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'done answer' });
    useLiveTurnsStore.getState().finish(key, 'done');

    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.status).toBe('done');
    expect(turn?.renderState.live).toBe('done answer');
  });

  it('finish on a key that was never started is a no-op', () => {
    useLiveTurnsStore.getState().finish('never-started', 'error');
    expect(useLiveTurnsStore.getState().turns['never-started']).toBeUndefined();
  });

  it('a fresh start replaces any prior entry for that key', () => {
    useLiveTurnsStore.getState().start(key);
    useLiveTurnsStore.getState().applyFrame(key, { type: 'content', delta: 'old turn' });
    useLiveTurnsStore.getState().finish(key, 'done');

    useLiveTurnsStore.getState().start(key);
    const turn = useLiveTurnsStore.getState().turns[key];
    expect(turn?.status).toBe('streaming');
    expect(turn?.renderState.live).toBe('');
  });
});
