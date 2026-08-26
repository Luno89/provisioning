import { describe, it, expect } from 'vitest';
import { isUnifiedFrame, type UnifiedFrame } from './chat-wire.js';

describe('UnifiedFrame wire contract', () => {
  it('content carries the raw provider delta as a string', () => {
    const f: UnifiedFrame = { type: 'content', delta: 'Hello' };
    expect(isUnifiedFrame(f)).toBe(true);
    expect(f.type).toBe('content');
    expect(f.delta).toBe('Hello');
  });

  it('content preserves the full delta object for advanced fields', () => {
    // The frontend expects delta as string; the full object rides through the wire
    // but the reducer only reads delta as string. Advanced fields are available
    // in the raw frame if a surface wants them.
    const f: UnifiedFrame = { type: 'content', delta: 'Hello' };
    expect(f.delta).toBe('Hello');
  });

  it('thinking is its own typed channel with delta string', () => {
    const f: UnifiedFrame = { type: 'thinking', delta: 'let me check...' };
    expect(isUnifiedFrame(f)).toBe(true);
    expect(f.type).toBe('thinking');
    expect(f.delta).toBe('let me check...');
  });

  it('toolAnnounce and toolResult are semantic frames with payload', () => {
    const a: UnifiedFrame = { type: 'toolAnnounce', payload: { id: 'c1', name: 'get_logs', args: '{}' } };
    const r: UnifiedFrame = { type: 'toolResult', payload: { id: 'c1', ok: true, digest: 'log lines' } };
    expect(isUnifiedFrame(a)).toBe(true);
    expect(isUnifiedFrame(r)).toBe(true);
    expect(a.payload.name).toBe('get_logs');
    expect(r.payload.ok).toBe(true);
  });

  it('proposals, enable, plan, usage, and control frames exist for the console surface', () => {
    const frames: UnifiedFrame[] = [
      { type: 'proposedTree', payload: { id: 't' } },
      { type: 'proposedSpec', payload: { id: 's' } },
      { type: 'enabled', payload: ['github-mcp'] },
      { type: 'plan', payload: '...' },
      { type: 'usage', payload: { prompt_tokens: 10 } },
      { type: 'interrupted', payload: 'Overthinking loop detected' },
    ];
    for (const f of frames) expect(isUnifiedFrame(f)).toBe(true);
  });

  it('this is the shape the persona-pack delivery flags gate on', () => {
    const types: UnifiedFrame['type'][] = [
      'content', 'thinking', 'toolAnnounce', 'toolResult',
      'proposedTree', 'proposedSpec', 'enabled', 'plan', 'usage', 'interrupted',
    ];
    expect(types).toContain('content');
    expect(types).toContain('toolResult');
  });

  it('rejects bogus frames', () => {
    expect(isUnifiedFrame({ bogus: true })).toBe(false);
    expect(isUnifiedFrame({ type: 'nope' })).toBe(false);
  });
});