import { describe, it, expect } from 'vitest';
import { progressiveCompact } from './progressive-compactor.js';

describe('progressive compaction pipeline', () => {
  it('leaves a short conversation alone when pressure is low', () => {
    const messages = [
      { role: 'system', content: 'You are an agent' },
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
    ];

    const result = progressiveCompact(messages, { windowTokens: 32_000 });
    expect(result.phase).toBe('normal');
    expect(result.messages).toHaveLength(3);
    expect(result.messages).toEqual(messages);
  });

  it('triggers soft masking on intermediate tool turns under moderate pressure', () => {
    const bigFileContent = 'export function foo() {}\n'.repeat(500);
    const messages = [
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'initial task' },
      { role: 'assistant', content: 'reading file', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.ts' }) } }] },
      { role: 'tool', name: 'read_file', content: bigFileContent },
      // Live tail:
      { role: 'user', content: 'follow up question' },
      { role: 'assistant', content: 'final answer' },
    ];

    // Force soft_mask pressure range
    const result = progressiveCompact(messages, {
      windowTokens: 3000,
      config: { softThreshold: 0.40, hardThreshold: 0.95 },
    });

    expect(result.phase).toBe('soft_mask');
    // Middle tool result was masked
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('File read: "big.ts"');
    expect(String(toolMsg?.content)).toContain('content elided');
    // Live tail remained intact
    expect(result.messages[result.messages.length - 1]?.content).toBe('final answer');
  });

  it('collapses into a Continuity State Frame under high pressure', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'build feature X' },
      ...Array.from({ length: 15 }, (_, i) => ([
        { role: 'assistant', content: `step ${i}`, tool_calls: [{ id: `${i}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `src/f${i}.ts`, content: 'code' }) } }] },
        { role: 'tool', name: 'write_file', content: 'ok' },
        { role: 'user', content: `clarification ${i}` },
      ])).flat(),
      { role: 'assistant', content: 'live tail assistant' },
    ];

    const result = progressiveCompact(messages, {
      windowTokens: 3500,
      config: { softThreshold: 0.20, hardThreshold: 0.40, criticalThreshold: 0.90, liveTailTurns: 4, preserveHeadTurns: 1 },
    });

    expect(result.phase).toBe('hard_compact');
    const notice = (result.messages as Array<{ handoff?: boolean; content?: unknown }>).find((m) => m.handoff);
    expect(notice).toBeDefined();
    expect(String(notice?.content)).toContain('### Primary Goal & Objective');
    expect(String(notice?.content)).toContain('build feature X');
    expect(String(notice?.content)).toContain('User Guidance & Cumulative Constraints');
    // Preserves recent tail
    expect(result.messages[result.messages.length - 1]?.content).toBe('live tail assistant');
  });

  it('marks critical_reset when even state compaction remains near token limits', () => {
    const hugeMessages = Array.from({ length: 50 }, (_, i) => ({
      role: 'user',
      content: `Extremely long prompt with lots of required directives that consume space: ${i} `.repeat(50),
    }));

    const result = progressiveCompact(hugeMessages, {
      windowTokens: 500,
      config: { criticalThreshold: 0.80 },
    });

    expect(result.phase).toBe('critical_reset');
  });
});
