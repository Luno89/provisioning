import { describe, it, expect } from 'vitest';
import { reduceUnifiedFrames, type ChatRenderState } from '../lib/chat-unified-reducer.js';

/**
 * RED: the unified frame reducer for ChatSurface.
 *
 * The backend now emits ONE wire: typed frames {type:'content'|'thinking'|'toolAnnounce'|'toolResult'|...}
 * This reducer turns a stream of those into the minimal render state a surface needs:
 *   - live text (assistant's prose)
 *   - live thinking (reasoning content)
 *   - tool pills (announced + results)
 *   - enabled services banner
 *
 * The old KoalaChat had this inline in a reader loop; the old Chat had it in stream-delta.ts.
 * Extracting it as a pure function makes it testable and shareable between surfaces.
 */

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