import { describe, it, expect } from 'vitest';
import { buildChatCompletionRequest } from './chat-pack-model-call.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

describe('buildChatCompletionRequest — the provider request for a pack turn', () => {
  it('uses tool-turn sampling: no conversation penalties that kill tool calls', () => {
    const req = buildChatCompletionRequest({ budget: BUDGET,
      baseUrl: 'http://x',
      provider: { kind: 'vllm', model: 'm' },
      messages: [{ role: 'user', content: 'hi' }],
      tools: ['get_logs'],
      overrides: {},
    });
    expect(req.stream).toBe(true);
    expect(req.frequency_penalty).toBeUndefined();
    expect(req.presence_penalty).toBeUndefined();
  });

  it('passes messages, tools, and the provider model through', () => {
    const req = buildChatCompletionRequest({ budget: BUDGET,
      baseUrl: 'http://x',
      provider: { kind: 'vllm', model: 'm' },
      messages: [{ role: 'user', content: 'hi' }],
      tools: ['get_logs'],
      overrides: {},
    });
    expect(req.model).toBe('m');
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(req.tools).toEqual(['get_logs']);
  });

  it('adds a forced bare wrap-up when toolChoice is none', () => {
    const req = buildChatCompletionRequest({ budget: BUDGET,
      baseUrl: 'http://x',
      provider: { kind: 'vllm' },
      messages: [], tools: [], overrides: {},
      toolChoice: 'none',
    });
    expect((req as any).tool_choice).toBe('none');
  });
});