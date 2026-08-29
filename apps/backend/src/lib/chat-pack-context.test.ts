import { describe, it, expect } from 'vitest';
import { appendUserTurn, buildKoalaPrompt, type ChatThread } from './chat-pack-context.js';

describe('appendUserTurn (koala vault policy)', () => {
  it('titles the first message and appends the user turn', () => {
    const thread: ChatThread = { id: 'c1', ownerId: 'u1', title: '', messages: [], createdAt: '', updatedAt: '' };
    const out = appendUserTurn(thread, 'hello world', '2026-01-01');
    expect(out.title).toBe('hello world');
    expect(out.messages).toEqual([{ role: 'user', content: 'hello world', at: '2026-01-01' }]);
    expect(out.updatedAt).toBe('2026-01-01');
  });

  it('keeps an existing title on later turns', () => {
    const thread: ChatThread = {
      id: 'c1', ownerId: 'u1', title: 'original', messages: [{ role: 'user', content: 'first', at: '1' }],
      createdAt: '', updatedAt: '',
    };
    const out = appendUserTurn(thread, 'second', '2');
    expect(out.title).toBe('original');
    expect(out.messages).toHaveLength(2);
  });

  it('builds the composition of the persona and enabled services speaking', () => {
    const system = buildKoalaPrompt('You are Koala.', [], ['svc-a']);
    expect(system).toContain('You are Koala.');
    expect(system).toContain('deployed');
  });
});