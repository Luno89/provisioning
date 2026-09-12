import { describe, it, expect } from 'vitest';
import { createStreamParser, type StreamEvent } from './stream.js';

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`;

function drain(chunks: string[]): StreamEvent[] {
  const parser = createStreamParser();
  const events: StreamEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.flush());
  return events;
}

describe('createStreamParser', () => {
  it('separates thinking from content', () => {
    const events = drain([
      frame({ choices: [{ delta: { reasoning_content: 'weighing it' } }] }),
      frame({ choices: [{ delta: { content: 'the answer' } }] }),
    ]);

    expect(events).toEqual([
      { kind: 'thinking', text: 'weighing it' },
      { kind: 'content', text: 'the answer' },
    ]);
  });

  it('also reads reasoning deltas sent as `reasoning` rather than `reasoning_content`', () => {
    const events = drain([frame({ choices: [{ delta: { reasoning: 'hmm' } }] })]);
    expect(events).toEqual([{ kind: 'thinking', text: 'hmm' }]);
  });

  it('reassembles a tool call whose arguments are split across many chunks', () => {
    const events = drain([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pods"' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }),
    ]);

    expect(events).toEqual([
      { kind: 'toolCall', call: { id: 'c1', name: 'search', arguments: '{"q":"pods"}' } },
    ]);
  });

  it('emits an earlier tool call once a later index starts streaming', () => {
    const parser = createStreamParser();
    const first = parser.push(
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] } }] }),
    );
    expect(first).toEqual([]);

    const second = parser.push(
      frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] } }] }),
    );
    expect(second).toEqual([{ kind: 'toolCall', call: { id: 'a', name: 'one', arguments: '{}' } }]);

    expect(parser.flush()).toEqual([{ kind: 'toolCall', call: { id: 'b', name: 'two', arguments: '{}' } }]);
  });

  it('handles a frame split mid-JSON across chunk boundaries', () => {
    const whole = frame({ choices: [{ delta: { content: 'split me' } }] });
    const events = drain([whole.slice(0, 20), whole.slice(20)]);
    expect(events).toEqual([{ kind: 'content', text: 'split me' }]);
  });

  it('ignores [DONE], blank payloads and malformed JSON without throwing', () => {
    const events = drain([
      'data: [DONE]\n',
      'data:\n',
      'data: {not json\n',
      ': a comment line\n',
      frame({ choices: [{ delta: { content: 'still here' } }] }),
    ]);
    expect(events).toEqual([{ kind: 'content', text: 'still here' }]);
  });

  it('captures usage and finish reason', () => {
    const events = drain([
      frame({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { total_tokens: 42 } }),
    ]);
    expect(events).toEqual([
      { kind: 'usage', usage: { total_tokens: 42 } },
      { kind: 'finish', reason: 'length' },
    ]);
  });

  it('emits nothing for an empty stream', () => {
    expect(drain([])).toEqual([]);
  });
});
