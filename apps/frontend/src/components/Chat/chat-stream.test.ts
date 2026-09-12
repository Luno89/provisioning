import { describe, it, expect } from 'vitest';
import { readSseFrames, assistantMsgFromRenderState } from './chat-stream.js';
import { emptyChatRenderState, type ChatRenderState } from '../../lib/chat-unified-reducer.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

describe('readSseFrames', () => {
  it('parses each data: line into a JSON frame', async () => {
    const frames: unknown[] = [];
    await readSseFrames(
      streamOf(['data: {"type":"content","delta":"a"}\n\n', 'data: {"type":"content","delta":"b"}\n\n']),
      (f) => frames.push(f),
    );
    expect(frames).toEqual([{ type: 'content', delta: 'a' }, { type: 'content', delta: 'b' }]);
  });

  it('skips [DONE] and blank lines', async () => {
    const frames: unknown[] = [];
    await readSseFrames(
      streamOf(['data: {"type":"content","delta":"a"}\n\n', 'data: [DONE]\n\n']),
      (f) => frames.push(f),
    );
    expect(frames).toEqual([{ type: 'content', delta: 'a' }]);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const frames: unknown[] = [];
    const whole = 'data: {"type":"content","delta":"abcdef"}\n\n';
    await readSseFrames(
      streamOf([whole.slice(0, 10), whole.slice(10)]),
      (f) => frames.push(f),
    );
    expect(frames).toEqual([{ type: 'content', delta: 'abcdef' }]);
  });

  it('ignores an unparseable frame rather than throwing', async () => {
    const frames: unknown[] = [];
    await readSseFrames(
      streamOf(['data: not json\n\n', 'data: {"type":"content","delta":"ok"}\n\n']),
      (f) => frames.push(f),
    );
    expect(frames).toEqual([{ type: 'content', delta: 'ok' }]);
  });
});

describe('assistantMsgFromRenderState', () => {
  it('returns null when nothing has streamed yet', () => {
    expect(assistantMsgFromRenderState(emptyChatRenderState)).toBeNull();
  });

  it('builds a message from live content, thinking, enabled services, and tool calls', () => {
    const state: ChatRenderState = {
      live: 'hello',
      liveThinking: 'reasoning here',
      tools: [{ id: 't1', name: 'get_logs', args: '{}', running: false, ok: true, digest: 'done' }],
      enabled: ['gitea-mcp-server'],
      proposals: [],
    };
    const msg = assistantMsgFromRenderState(state);
    expect(msg).toMatchObject({
      role: 'assistant',
      content: 'hello',
      reasoning: 'reasoning here',
      enabled: ['gitea-mcp-server'],
      toolCalls: [{ id: 't1', name: 'get_logs', args: '{}', ok: true, digest: 'done' }],
    });
  });

  it('still returns a message carrying only an interruptedReason, with no content', () => {
    const state: ChatRenderState = { ...emptyChatRenderState, interruptedReason: 'Stopped' };
    const msg = assistantMsgFromRenderState(state);
    expect(msg).toMatchObject({ role: 'assistant', content: '', interruptedReason: 'Stopped' });
  });

  it('omits interruptedReason from the message when none was set', () => {
    const state: ChatRenderState = { ...emptyChatRenderState, live: 'hi' };
    const msg = assistantMsgFromRenderState(state);
    expect(msg).not.toHaveProperty('interruptedReason');
  });
});
