import { describe, it, expect } from 'vitest';
import { trimConversation } from './sandbox-tools.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

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
    const convo = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...Array.from({ length: 8 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    expect(measure(convo)).toBeGreaterThan(BUDGET.conversationChars);
    expect(measure(trimConversation(convo as any, BUDGET.conversationChars))).toBeLessThanOrEqual(BUDGET.conversationChars);
  });

  it('keeps the call and drops only the payload', () => {
    const convo = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...Array.from({ length: 10 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    const out = trimConversation(convo as any, BUDGET.conversationChars) as any[];
    const elided = out.filter((m) => m.tool_calls?.[0]?.function?.arguments?.includes('already written'));
    expect(elided.length).toBeGreaterThan(0);
    expect(elided[0].tool_calls[0].function.name).toBe('write_file');
    expect(elided[0].tool_calls[0].function.arguments).toContain('src/f0.js');
  });

  it('leaves the most recent turns whole', () => {
    const convo = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...Array.from({ length: 10 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    const out = trimConversation(convo as any, BUDGET.conversationChars) as any[];
    expect(out[out.length - 1].tool_calls[0].function.arguments).toContain('xxx');
  });

  it('never touches the system prompt or the task', () => {
    const convo = [
      { role: 'system', content: 's'.repeat(5000) },
      { role: 'user', content: 't'.repeat(5000) },
      ...Array.from({ length: 12 }, (_, i) => write(`src/f${i}.js`, 9000)),
    ];
    const out = trimConversation(convo as any, BUDGET.conversationChars) as any[];
    expect(out[0].content).toHaveLength(5000);
    expect(out[1].content).toHaveLength(5000);
  });

  it('leaves a small write alone', () => {
    const convo = [{ role: 'system', content: 's' }, { role: 'user', content: 't' }, write('a.txt', 40)];
    expect(trimConversation(convo as any, BUDGET.conversationChars)).toEqual(convo);
  });
});
