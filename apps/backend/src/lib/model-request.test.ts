import { describe, it, expect } from 'vitest';
import { buildModelRequest } from './model-request.js';
import { PACK_SEEDS } from './pack-seeds.js';

/**
 * A pack is passed in because there is no base layer left: what used to be "the built-in sampling"
 * is a record the caller supplies, so a request built without one carries no sampler at all.
 */
const spec = (over: Partial<Parameters<typeof buildModelRequest>[0]> = {}) => buildModelRequest({
  turn: 'conversation', kind: 'tabbyapi', messages: [{ role: 'user', content: 'hi' }],
  sampling: PACK_SEEDS[0]!.sampling,
  stream: true, maxTokens: 8192, ...over,
});

describe('what reaches the wire', () => {
  it("sends the pack's sampler for the turn kind it is given", () => {
    const { body } = spec({
      sampling: { toolTurn: {}, conversation: { frequency_penalty: 0, presence_penalty: 0 } },
    });

    expect(body.frequency_penalty).toBe(0);
    expect(body.presence_penalty).toBe(0);
  });

  it('sends nothing at all when no pack is given, rather than a hidden base', () => {
    const { body } = spec({ sampling: undefined });

    expect(body.temperature).toBeUndefined();
    expect(body.frequency_penalty).toBeUndefined();
  });

  it('never lets a knob reach a transport field', () => {
    const { body } = spec({ extra: { stream_options: { include_usage: true } } });
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('placement — where a knob lands on the wire', () => {
  it('nests a template_vars knob instead of sending it flat', () => {
    const { body } = spec({ think: true });

    expect(body.think).toBeUndefined();
    expect(body.template_vars).toMatchObject({ enable_thinking: true });
  });

  it('merges into template_vars rather than replacing what is there', () => {
    const { body } = spec({ turn: 'tool-turn', think: false });
    expect(body.template_vars).toMatchObject({ enable_thinking: false });
  });

  it('never transmits a knob the loop reads locally', () => {
    const { body } = spec({
      sampling: { toolTurn: { maxSteps: 30 } as never, conversation: { maxSteps: 30 } as never },
    });
    expect(body.maxSteps).toBeUndefined();
  });

  it('drops an engine-gated knob on the wrong engine, and says it did', () => {
    const { body, unsupported } = spec({ kind: 'vllm', sampling: { toolTurn: { dry_multiplier: 0.8 }, conversation: { dry_multiplier: 0.8 } } });

    expect(body.dry_multiplier).toBeUndefined();
    expect(unsupported).toContain('dry_multiplier');
  });

  it('sends a knob the table has never heard of, since engines have their own', () => {
    // These were reported as unsupported when they arrived as overrides. A pack's sampler names its
    // own engine's parameters, so refusing them would stop a pack describing its engine. A knob the
    // table DOES know and gates by engine is still dropped and reported — the test above.
    const { body, unsupported } = spec({
      sampling: { toolTurn: { made_up_sampler: 1 }, conversation: { made_up_sampler: 1 } },
    });

    expect(body.made_up_sampler).toBe(1);
    expect(unsupported).not.toContain('made_up_sampler');
  });
});

describe('the two kinds of turn', () => {
  it('gives a dispatch turn no repetition penalties', () => {
    const { body } = spec({ turn: 'tool-turn' });

    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
  });

  it('keeps them for a turn that produces prose for a human', () => {
    const { body } = spec({ turn: 'conversation' });
    expect(body.frequency_penalty).toBeGreaterThan(0);
  });

  it('still lets a dispatch turn be overridden back', () => {
    const { body } = spec({ turn: 'tool-turn', sampling: { toolTurn: { frequency_penalty: 0.4 }, conversation: { frequency_penalty: 0.4 } } });
    expect(body.frequency_penalty).toBe(0.4);
  });
});

describe('what the caller always controls', () => {
  it('carries messages, tools and stream through untouched', () => {
    const tools = [{ type: 'function', function: { name: 'x' } }];
    const { body } = spec({ tools, stream: false });

    expect(body.tools).toBe(tools);
    expect(body.stream).toBe(false);
  });

  it('omits tools entirely when none are offered', () => {
    const { body } = spec({});
    expect('tools' in body).toBe(false);
  });

  it('sends the served model name when there is one', () => {
    const { body } = spec({ model: 'Qwen3-32B' });
    expect(body.model).toBe('Qwen3-32B');
  });
});
