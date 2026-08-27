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
    expect(contentFrame?.delta).toBe('Here are the logs.');
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

  it('streams thinking, tools, proposals, and enabled services live through onFrame', async () => {
    const reasoning = (r: string) => fakeStream([delts({ reasoning_content: r })]);
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: reasoning('I should check logs.') })
      .mockResolvedValueOnce({ ok: true, body: tool('c2', 'get_logs', '{}') })
      .mockResolvedValueOnce({ ok: true, body: content('Done.') });

    const liveFrames: UnifiedFrame[] = [];
    const executeTool = vi.fn().mockResolvedValue({
      content: 'ok logs',
      ok: true,
      enabled: 'k8s',
      proposed: { id: 'tree-1', name: 'App' },
    });

    const result = await runChatTurn({
      pack: KOALA_PACK,
      messages: [{ role: 'user', content: 'test' }],
      tools: ['get_logs'],
      call,
      executeTool,
      onFrame: (f) => liveFrames.push(f),
    });

    expect(result.answer).toBe('Done.');
    const types = liveFrames.map((f) => f.type);
    expect(types).toContain('thinking');
    expect(types).toContain('toolAnnounce');
    expect(types).toContain('toolResult');
    expect(types).toContain('proposedTree');
    expect(types).toContain('enabled');
    expect(types).toContain('content');
  });
});