import { describe, it, expect, vi } from 'vitest';
import { runChatTurn } from './chat-runtime.js';
import { KOALA_PACK } from './persona-pack.js';
import type { UnifiedFrame } from './chat-wire.js';

/**
 * End-to-end proof the engine actually runs a turn: drive runChatTurn with the KOALA_PACK and a
 * fake model that answers one tool call then the final answer, and assert the delivery-filtered
 * frames the assistant surface produces.
 */

function fakeStream(chunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() { return { read: async () => i < chunks.length
      ? { done: false, value: enc.encode(chunks[i++]) }
      : { done: true, value: undefined } }; },
  };
}
const delts = (d: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
const content = (t: string) => fakeStream([delts({ content: t })]);
const tool = (id: string, name: string, args: string) =>
  fakeStream([delts({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] })]);

describe('runChatTurn (Koala pack, fake model)', () => {
  it('runs a tool-answering turn and returns delivery-filtered assistant frames', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: tool('c1', 'get_logs', '{"pod":"p"}') })
      .mockResolvedValueOnce({ ok: true, body: content('Here are the logs.') });
    const executeTool = vi.fn().mockResolvedValue({
      content: 'log lines', ok: true, proposed: { id: 'pt1' },
    });

    const result = await runChatTurn({
      pack: KOALA_PACK,
      messages: [{ role: 'system', content: 'You are Koala.' }, { role: 'user', content: 'check' }],
      tools: ['get_logs'],
      call,
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledWith({ id: 'c1', name: 'get_logs', arguments: '{"pod":"p"}' });
    expect(result.answer).toBe('Here are the logs.');

    const types = result.frames.map((f: UnifiedFrame) => f.type);
    // Assistant surface: content, tool lifecycle, and the proposed card.
    expect(types).toContain('content');
    expect(types).toContain('toolAnnounce');
    expect(types).toContain('toolResult');
    expect(types).toContain('proposedTree');
    const contentFrame = result.frames.find((f) => f.type === 'content');
    expect((contentFrame as any).delta.content).toBe('Here are the logs.');
  });

  it('streams content live through onEachToolResult as it parses', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, body: content('live-answer') });
    const live: UnifiedFrame[] = [];
    const result = await runChatTurn({
      pack: KOALA_PACK,
      messages: [{ role: 'user', content: 'hi' }],
      call,
      executeTool: async () => ({ content: '' }),
      onEachToolResult: (f) => live.push(f),
    });
    expect(result.answer).toBe('live-answer');
    expect(live.some((f) => f.type === 'content')).toBe(true);
  });
});