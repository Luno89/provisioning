import { describe, it, expect } from 'vitest';
import { COMPACTION_PREFIX, SUMMARY_TOOL_CHARS, compactedView, compactionBoundary, summaryRequest } from './context.js';
import type { ChatMessage } from '../values.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const said = (content: string): ChatMessage => ({ role: 'assistant', content });
const calls = (name: string, args: string): ChatMessage => ({ role: 'assistant', content: '', toolCalls: [{ id: name, name, arguments: args }] });
const tool = (content: string, name = 'read_file'): ChatMessage => ({ role: 'tool', content, toolCallId: name, name });

describe('the view a compaction gives the model', () => {
  it('puts the summary where the messages it covers were, and sends the rest as they are', () => {
    const messages = [user('a'), said('b'), user('c'), said('d')];

    expect(compactedView(messages, { summary: 'a and b happened', through: 2 })).toEqual([
      { role: 'user', content: `${COMPACTION_PREFIX}\n\na and b happened` },
      user('c'),
      said('d'),
    ]);
    expect(compactedView(messages, undefined)).toEqual(messages);
  });

  it('sends everything when the summary claims more messages than there are', () => {
    expect(compactedView([user('a')], { summary: 's', through: 5 })).toEqual([user('a')]);
  });
});

describe('where a compaction keeps the tail from', () => {
  it('keeps the last few messages, never starting on a tool result cut off from its call', () => {
    const messages = [user('go'), calls('read_file', '{}'), tool('page'), calls('read_file', '{}'), tool('page'), said('done')];

    expect(compactionBoundary(messages, 2)).toBe(3);
    expect(compactionBoundary(messages, 3)).toBe(3);
  });

  it('keeps less than asked when the tail alone would not fit, but never parts the latest calls from their results', () => {
    const big = 'x'.repeat(1000);
    const messages = [user('go'), calls('read_file', '{}'), tool(big), calls('read_file', '{}'), tool(big), calls('read_file', '{}'), tool(big)];

    expect(compactionBoundary(messages, 6, 2500)).toBe(3);
    expect(compactionBoundary(messages, 6, 10)).toBe(5);
  });

  it('has nothing to summarise when the tail is everything', () => {
    expect(compactionBoundary([user('go'), said('ok')], 6)).toBe(0);
    expect(compactionBoundary([user('go'), tool('x'), tool('y')], 2)).toBe(0);
  });
});

describe('what the model is asked to summarise', () => {
  it('is one transcript, with each tool result clipped and each call named', () => {
    const [request] = summaryRequest([user('read the docs'), calls('read_file', '{"path":"a.md"}'), tool('y'.repeat(SUMMARY_TOOL_CHARS * 3))]);

    expect(request!.role).toBe('user');
    expect(request!.content).toContain('[user]\nread the docs');
    expect(request!.content).toContain('[called read_file({"path":"a.md"})]');
    expect(request!.content).toContain('[tool result from read_file]');
    expect(request!.content.length).toBeLessThan(SUMMARY_TOOL_CHARS * 2);
  });
});
