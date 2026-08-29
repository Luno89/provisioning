import { describe, it, expect, vi } from 'vitest';
import { runChatTurn } from './chat-runtime.js';
import type { UnifiedFrame } from './chat-wire.js';

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

describe('runChatTurn (fake model)', () => {
  it('runs a tool-answering turn and streams the whole lifecycle', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: tool('c1', 'get_logs', '{"pod":"p"}') })
      .mockResolvedValueOnce({ ok: true, body: content('Here are the logs.') });
    const executeTool = vi.fn().mockResolvedValue({
      content: 'log lines', ok: true, proposed: { id: 'pt1' },
    });

    const frames: UnifiedFrame[] = [];
    const result = await runChatTurn({
      messages: [{ role: 'system', content: 'You are Koala.' }, { role: 'user', content: 'check' }],
      tools: ['get_logs'],
      call,
      executeTool,
      onFrame: (f) => frames.push(f),
    });

    expect(executeTool).toHaveBeenCalledWith({ id: 'c1', name: 'get_logs', arguments: '{"pod":"p"}' });
    expect(result.answer).toBe('Here are the logs.');

    const types = frames.map((f: UnifiedFrame) => f.type);
    expect(types).toContain('content');
    expect(types).toContain('toolAnnounce');
    expect(types).toContain('toolResult');
    expect(types).toContain('proposedTree');
    const contentFrame = frames.find((f) => f.type === 'content');
    expect(contentFrame && 'delta' in contentFrame ? contentFrame.delta : '').toBe('Here are the logs.');
  });

  it('streams content live through onEachToolResult as it parses', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, body: content('live-answer') });
    const live: UnifiedFrame[] = [];
    const result = await runChatTurn({
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

  it('emits every channel regardless of the pack, because nothing filters at the source', async () => {
    const reasoning = (r: string) => fakeStream([delts({ reasoning_content: r })]);
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: reasoning('thinking out loud') })
      .mockResolvedValueOnce({ ok: true, body: tool('c9', 'get_logs', '{}') })
      .mockResolvedValueOnce({ ok: true, body: content('done') });

    const frames: UnifiedFrame[] = [];
    await runChatTurn({
      messages: [{ role: 'user', content: 'go' }],
      tools: ['get_logs'],
      call,
      executeTool: async () => ({
        content: 'out', ok: true, enabled: 'sql-mcp', proposed: { id: 't' }, proposedSpec: { id: 's' },
      }),
      onFrame: (f) => frames.push(f),
    });

    for (const type of ['thinking', 'toolAnnounce', 'toolResult', 'content', 'enabled', 'proposedTree', 'proposedSpec']) {
      expect(frames.map((f) => f.type), type).toContain(type);
    }
  });
});
