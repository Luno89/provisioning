import { describe, it, expect } from 'vitest';
import { reduceUnifiedFrames, type ChatRenderState } from '../lib/chat-unified-reducer.js';

const empty: ChatRenderState = {
  live: '', liveThinking: '', tools: [],
};

describe('reduceUnifiedFrames — unified wire → render state', () => {
  it('accumulates content deltas into live text', () => {
    let s = reduceUnifiedFrames(empty, { type: 'content', delta: 'He' });
    s = reduceUnifiedFrames(s, { type: 'content', delta: 'llo' });
    expect(s.live).toBe('Hello');
  });

  it('accumulates thinking deltas into liveThinking', () => {
    let s = reduceUnifiedFrames(empty, { type: 'thinking', delta: 'let me' });
    s = reduceUnifiedFrames(s, { type: 'thinking', delta: ' check' });
    expect(s.liveThinking).toBe('let me check');
  });

  it('adds a tool pill as running on toolAnnounce', () => {
    const s = reduceUnifiedFrames(empty, {
      type: 'toolAnnounce',
      payload: { id: 'c1', name: 'get_logs', args: '{"pod":"p"}' },
    });
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]).toMatchObject({ id: 'c1', name: 'get_logs', running: true });
  });

  it('flips the pill to done with ok/digest on toolResult', () => {
    let s = reduceUnifiedFrames(empty, {
      type: 'toolAnnounce', payload: { id: 'c1', name: 'get_logs', args: '{}' },
    });
    s = reduceUnifiedFrames(s, {
      type: 'toolResult', payload: { id: 'c1', ok: true, digest: 'log lines...' },
    });
    expect(s.tools[0]).toMatchObject({ running: false, ok: true, digest: 'log lines...' });
  });

  it('keeps what a tool made on its pill, so the chat can link to it', () => {
    let s = reduceUnifiedFrames(empty, { type: 'toolAnnounce', payload: { id: 'c1', name: 'research', args: '{}' } });
    s = reduceUnifiedFrames(s, {
      type: 'toolResult',
      payload: { id: 'c1', ok: true, digest: 'done', artifacts: [{ kind: 'file', workspace: 'conversation-x', path: 'research/r1/findings.md' }] },
    });
    expect(s.tools[0]!.artifacts).toEqual([{ kind: 'file', workspace: 'conversation-x', path: 'research/r1/findings.md' }]);
  });
});