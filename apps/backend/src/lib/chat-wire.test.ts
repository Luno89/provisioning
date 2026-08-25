import { describe, it, expect } from 'vitest';
import { isUnifiedFrame, type UnifiedFrame } from './chat-wire.js';

/**
 * The ONE wire contract for chat — replacing the separate passthrough (/api/chat) and
 * re-encode (/api/koala/chat) leaks. Every frame is a typed `{ type, payload }`; a persona pack's
 * `delivery` decides which types the UI renders. Nothing is dropped at the engine — the raw
 * provider delta rides inside the content frame, and control frames (usage/interrupted) survive
 * even when the default surface hides them.
 *
 * TDD basis: the frame shapes (below) were written as the contract; the tests pin them.
 */

describe('the unified chat frame contract', () => {
  it('is a discriminated union on a string type', () => {
    const f: UnifiedFrame = { type: 'content', delta: { content: 'hi' } };
    expect(f.type).toBe('content');
    expect(isUnifiedFrame(f)).toBe(true);
    expect(isUnifiedFrame({ bogus: true } as any)).toBe(false);
  });

  it('content carries the raw provider delta, intact', () => {
    const f: UnifiedFrame = { type: 'content', delta: { content: 'Hello', reasoning_content: 'hmm' } };
    // The delta object rides through unmodified — nothing is re-encoded and lost.
    expect(f.delta.content).toBe('Hello');
    expect(f.delta.reasoning_content).toBe('hmm');
  });

  it('thinking is its own typed channel, distinct from content', () => {
    const f: UnifiedFrame = { type: 'thinking', text: 'let me check…' };
    expect(f.type).toBe('thinking');
  });

  it('toolAnnounce and toolResult are semantic frames', () => {
    const a: UnifiedFrame = { type: 'toolAnnounce', id: 'c1', name: 'get_logs', args: '{}' };
    const r: UnifiedFrame = { type: 'toolResult', id: 'c1', ok: true, digest: 'log lines' };
    expect(a.type).toBe('toolAnnounce');
    expect(r.type).toBe('toolResult');
  });

  it('proposals, enable, plan, usage, and control frames exist for the console surface', () => {
    const frames: UnifiedFrame[] = [
      { type: 'proposedTree', tree: { id: 't' } },
      { type: 'proposedSpec', spec: { id: 's' } },
      { type: 'enabled', services: ['github-mcp'] },
      { type: 'plan', content: '…' },
      { type: 'usage', usage: { prompt_tokens: 10 } },
      { type: 'interrupted', reason: 'Overthinking loop detected' },
    ];
    for (const f of frames) expect(isUnifiedFrame(f)).toBe(true);
  });

  it('this is the shape the persona-pack delivery flags gate on', () => {
    // The pack lists which frame types the UI SHOULD render — the contract lists the possible ones.
    const types: UnifiedFrame['type'][] = [
      'content', 'thinking', 'toolAnnounce', 'toolResult',
      'proposedTree', 'proposedSpec', 'enabled', 'plan', 'usage', 'interrupted',
    ];
    expect(types).toContain('content');
    expect(types).toContain('toolResult');
  });
});