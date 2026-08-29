import { describe, it, expect } from 'vitest';
import { reduceUnifiedFrames, type ChatRenderState } from '../lib/chat-unified-reducer.js';

const empty: ChatRenderState = {
  live: '', liveThinking: '', tools: [], enabled: [], proposals: [],
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

  it('accumulates enabled services', () => {
    let s = reduceUnifiedFrames(empty, { type: 'enabled', payload: ['github-mcp'] });
    s = reduceUnifiedFrames(s, { type: 'enabled', payload: ['linear'] });
    expect(s.enabled).toEqual(['github-mcp', 'linear']);
  });
});