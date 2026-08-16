import { describe, it, expect } from 'vitest';
import { trimConversation, CONVERSATION_CHAR_BUDGET } from './sandbox-tools.js';

/**
 * Does the conversation actually fit?
 *
 * The trimmer measured `content` only, and a write_file call's arguments are not content — they
 * sit on the assistant message's tool_calls and hold the whole file. So a conversation made of
 * file writes looked nearly empty to the budget while being the largest thing the model had to
 * read, and a leaf that rewrote a 9 KB test file three times died on:
 *
 *   requires 34816 cache tokens, which exceeds the available context size of 32768
 *
 * These assert the SIZE of what comes out, which is the property that matters, rather than which
 * branch of the function ran.
 */
const write = (path: string, bytes: number) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{
    id: 'c1',
    type: 'function',
    function: { name: 'write_file', arguments: JSON.stringify({ path, content: 'x'.repeat(bytes) }) },
  }],
});

const measure = (ms: any[]) => ms.reduce(
  (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0)
    + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
  0,
);

describe('keeping a conversation inside the context', () => {
  it('counts what a file write actually costs', () => {
    // The blind spot itself: three 9 KB writes are ~27 KB the old measurement scored as zero.
    const convo = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...Array.from({ length: 8 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    expect(measure(convo)).toBeGreaterThan(CONVERSATION_CHAR_BUDGET);
    expect(measure(trimConversation(convo as any))).toBeLessThanOrEqual(CONVERSATION_CHAR_BUDGET);
  });

  it('keeps the call and drops only the payload', () => {
    /**
     * The thread — which tool ran, on which path, in what order — is what an assistant turn is
     * for. The file contents are already on disk.
     */
    const convo = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...Array.from({ length: 10 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    const out = trimConversation(convo as any) as any[];
    const elided = out.filter((m) => m.tool_calls?.[0]?.function?.arguments?.includes('already written'));
    expect(elided.length).toBeGreaterThan(0);
    // Still a write_file call, still naming its path.
    expect(elided[0].tool_calls[0].function.name).toBe('write_file');
    expect(elided[0].tool_calls[0].function.arguments).toContain('src/f0.js');
  });

  it('leaves the most recent turns whole', () => {
    // The next decision depends on them; trimming newest-first would defeat the purpose.
    const convo = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...Array.from({ length: 10 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    const out = trimConversation(convo as any) as any[];
    expect(out[out.length - 1].tool_calls[0].function.arguments).toContain('xxx');
  });

  it('never touches the system prompt or the task', () => {
    const convo = [
      { role: 'system', content: 's'.repeat(5000) },
      { role: 'user', content: 't'.repeat(5000) },
      ...Array.from({ length: 12 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    const out = trimConversation(convo as any) as any[];
    expect(out[0].content).toHaveLength(5000);
    expect(out[1].content).toHaveLength(5000);
  });

  it('leaves a small write alone', () => {
    // Eliding a 40-byte file reclaims nothing and loses the content the model may still be using.
    const convo = [{ role: 'system', content: 's' }, { role: 'user', content: 't' }, write('a.txt', 40)];
    expect(trimConversation(convo as any)).toEqual(convo);
  });
});
