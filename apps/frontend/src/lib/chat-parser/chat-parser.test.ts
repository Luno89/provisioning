import { describe, it, expect } from 'vitest';
import { ChatParser } from './chat-parser.js';

describe('ChatParser', () => {
  it('strips internal LLM control tokens', () => {
    const raw = '<|im_start|>assistant\n<|start_header_id|>system<|end_header_id|>Hello world<|im_end|><|eot_id|>';
    const parsed = ChatParser.parse(raw);
    expect(parsed.cleanContent).toBe('assistant\nHello world');
  });

  it('extracts closed <think>...</think> reasoning blocks', () => {
    const raw = '<think>I need to search the database first and check indices.</think>Here is the answer to your query.';
    const parsed = ChatParser.parse(raw);
    expect(parsed.thoughts).toHaveLength(1);
    expect(parsed.thoughts[0]).toBe('I need to search the database first and check indices.');
    expect(parsed.cleanContent).toBe('Here is the answer to your query.');
    expect(parsed.isThinking).toBe(false);
  });

  it('handles streaming open <think> tags gracefully', () => {
    const raw = '<think>Currently analyzing constraints for Kubernetes Pod CDI...';
    const parsed = ChatParser.parse(raw);
    expect(parsed.thoughts).toHaveLength(1);
    expect(parsed.thoughts[0]).toContain('Currently analyzing constraints');
    expect(parsed.isThinking).toBe(true);
    expect(parsed.cleanContent).toBe('');
  });

  it('normalizes LaTeX math delimiters', () => {
    const raw = 'The equation is \\( E = mc^2 \\) and in block mode: \\[ \\int_0^\\infty x dx \\]';
    const parsed = ChatParser.parse(raw);
    expect(parsed.hasMath).toBe(true);
    expect(parsed.cleanContent).toContain('$E = mc^2$');
    expect(parsed.cleanContent).toContain('$$\n\\int_0^\\infty x dx\n$$');
  });

  it('extracts embedded tool call structures', () => {
    const raw = 'Let me look that up:\n<tool_call>{"name":"get_logs","arguments":{"deployment":"tabby"}}</tool_call>\nFound log stream.';
    const parsed = ChatParser.parse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.name).toBe('get_logs');
    expect(parsed.cleanContent).toContain('Let me look that up:');
    expect(parsed.cleanContent).toContain('Found log stream.');
  });
});
