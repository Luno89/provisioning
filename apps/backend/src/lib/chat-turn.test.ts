import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import {
  stripThinkTags, standardPostPasses, openTurnSse, createOverthinkMonitor, createTurnAccumulator,
} from './chat-turn.js';
import { ThoughtFeatureExtractor } from './thinking-classifier.js';
import type { Database } from './db-interface.js';

describe('stripThinkTags', () => {
  it('extracts a <think> block and strips it from the visible reply', () => {
    const out = stripThinkTags('<think>reasoning here</think>the actual answer');
    expect(out.thinking).toBe('reasoning here');
    expect(out.clean).toBe('the actual answer');
  });

  it('handles an unterminated <think> block by taking everything after it as thinking', () => {
    const out = stripThinkTags('<think>still going');
    expect(out.thinking).toBe('still going');
  });

  it('returns the original text unchanged when there is no <think> tag', () => {
    const out = stripThinkTags('plain reply');
    expect(out).toEqual({ clean: 'plain reply', thinking: '' });
  });

  it('falls back to the original text if stripping leaves nothing', () => {
    const out = stripThinkTags('<think>only thoughts</think>');
    expect(out.clean).toBe('<think>only thoughts</think>');
  });
});

describe('standardPostPasses', () => {
  it('continues from where it left off when the finish reason is length', () => {
    const [lengthPass] = standardPostPasses(new ThoughtFeatureExtractor());
    expect(lengthPass!.when({ originalMessages: [], turn: [], answer: 'a', spoken: '', thinking: '', finishReason: 'length' })).toBe(true);
    const msgs = lengthPass!.buildMessages({ originalMessages: [{ role: 'user', content: 'hi' }], turn: [], answer: 'partial', spoken: '', thinking: '' });
    expect(msgs).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: 'Continue your response from exactly where you left off.' },
    ]);
  });

  it('recovers a monologue-only reply by asking for a concise final answer', () => {
    const [, monologuePass] = standardPostPasses(new ThoughtFeatureExtractor());
    expect(monologuePass!.when({ originalMessages: [], turn: [], answer: '', spoken: '', thinking: 'a long chain of thought over twenty chars' })).toBe(true);
    expect(monologuePass!.when({ originalMessages: [], turn: [], answer: 'already answered', spoken: '', thinking: 'irrelevant' })).toBe(false);
  });
});

describe('openTurnSse', () => {
  it('opens the stream and sends nothing extra when no services are enabled', () => {
    const writes: string[] = [];
    const res = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: (s: string) => writes.push(s) } as unknown as Response;
    openTurnSse(res, []);
    expect(writes).toEqual([]);
  });

  it('sends an initial enabled frame when services are already enabled', () => {
    const writes: string[] = [];
    const res = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: (s: string) => writes.push(s) } as unknown as Response;
    openTurnSse(res, ['gitea-mcp-server']);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.replace('data: ', ''))).toEqual({ type: 'enabled', payload: ['gitea-mcp-server'] });
  });
});

function fakeRes() {
  const writes: string[] = [];
  let closeHandler: (() => void) | undefined;
  const res = {
    write: (s: string) => writes.push(s),
    on: (event: string, cb: () => void) => { if (event === 'close') closeHandler = cb; },
    writableEnded: false,
  } as unknown as Response;
  return { res, writes, close: () => closeHandler?.() };
}

function fakeDb(): Database & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    getModelThinkingProfile: vi.fn(async () => null),
    saveModelThinkingProfile: vi.fn(async (p: unknown) => { saved.push(p); }),
    saved,
  } as unknown as Database & { saved: unknown[] };
}

describe('createOverthinkMonitor', () => {
  it('does not warn on a short, unremarkable reply', async () => {
    const { res, writes } = fakeRes();
    const db = fakeDb();
    const monitor = await createOverthinkMonitor({ db, targetModelId: 'm1', seedMessage: 'hi', res });
    monitor.onStreamEvent({ kind: 'reasoning', text: 'a short thought' });
    expect(writes).toEqual([]);
  });

  it('warns exactly once on a detected repetition loop, even across repeated events', async () => {
    const { res, writes } = fakeRes();
    const db = fakeDb();
    const monitor = await createOverthinkMonitor({ db, targetModelId: 'm1', seedMessage: 'hi', res });
    const loop = 'the same phrase over and over '.repeat(60);
    monitor.onStreamEvent({ kind: 'reasoning', text: loop });
    monitor.onStreamEvent({ kind: 'reasoning', text: loop });
    const frames = writes.map((w) => JSON.parse(w.replace('data: ', '')));
    expect(frames.filter((f) => f.type === 'overthinkWarning')).toHaveLength(1);
  });

  it('records a failure sample on close only if it actually warned', async () => {
    const { res, close } = fakeRes();
    const db = fakeDb();
    const monitor = await createOverthinkMonitor({ db, targetModelId: 'm1', seedMessage: 'hi', res });
    monitor.onStreamEvent({ kind: 'reasoning', text: 'nothing alarming' });
    close();
    expect(db.saveModelThinkingProfile).not.toHaveBeenCalled();
  });

  it('recordOutcome saves a success or failure profile sample', async () => {
    const { res } = fakeRes();
    const db = fakeDb();
    const monitor = await createOverthinkMonitor({ db, targetModelId: 'm1', seedMessage: 'hi', res });
    await monitor.recordOutcome(false);
    expect(db.saveModelThinkingProfile).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'm1', successSamples: 1 }));
  });
});

describe('createTurnAccumulator', () => {
  it('accumulates content, thinking, enabled services, and tool calls from frames', () => {
    const acc = createTurnAccumulator(['gitea-mcp-server']);
    acc.onFrame({ type: 'content', delta: 'Hello ' });
    acc.onFrame({ type: 'content', delta: 'world' });
    acc.onFrame({ type: 'thinking', delta: 'thinking...' });
    acc.onFrame({ type: 'enabled', payload: ['github-repo-research'] });
    acc.onFrame({ type: 'toolAnnounce', payload: { id: 't1', name: 'get_logs', args: '{}' } });
    acc.onFrame({ type: 'toolResult', payload: { id: 't1', ok: true, digest: 'done' } });

    expect(acc.hasContent()).toBe(true);
    expect(acc.toSalvagedFields()).toEqual({
      content: 'Hello world',
      reasoning: 'thinking...',
      enabled: ['gitea-mcp-server', 'github-repo-research'],
      toolCalls: [{ id: 't1', name: 'get_logs', args: '{}', ok: true, digest: 'done' }],
    });
  });

  it('reports no content when nothing has arrived yet', () => {
    const acc = createTurnAccumulator();
    expect(acc.hasContent()).toBe(false);
    expect(acc.toSalvagedFields()).toEqual({ content: '' });
  });

  it('ignores a toolResult for a tool call that was never announced', () => {
    const acc = createTurnAccumulator();
    acc.onFrame({ type: 'toolResult', payload: { id: 'ghost', ok: true } });
    expect(acc.hasContent()).toBe(false);
  });
});
