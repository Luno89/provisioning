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

describe('precedence', () => {
  it('lets an override beat the built-in sampling', () => {
    const { body } = spec({ overrides: { frequency_penalty: 0, presence_penalty: 0 } });

    expect(body.frequency_penalty).toBe(0);
    expect(body.presence_penalty).toBe(0);
  });

  it('keeps the pack\'s value where nothing overrode it', () => {
    const { body } = spec({ overrides: { temperature: 0.2 } });

    expect(body.temperature).toBe(0.2);
    expect(body.frequency_penalty).toBeGreaterThan(0);
  });

  it('never lets an override reach a transport field', () => {
    const { body } = spec({ extra: { stream_options: { include_usage: true } } });
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('placement — where a knob lands on the wire', () => {
  it('nests a template_vars knob instead of sending it flat', () => {
    const { body } = spec({ overrides: { think: true } });

    expect(body.think).toBeUndefined();
    expect(body.template_vars).toMatchObject({ enable_thinking: true });
  });

  it('merges into template_vars rather than replacing what is there', () => {
    const { body } = spec({
      turn: 'tool-turn', overrides: { think: false },
    });
    expect(body.template_vars).toMatchObject({ enable_thinking: false });
  });

  it('never transmits a knob the loop reads locally', () => {
    const { body } = spec({ overrides: { maxSteps: 30 } });
    expect(body.maxSteps).toBeUndefined();
  });

  it('drops an engine-gated knob on the wrong engine, and says it did', () => {
    const { body, unsupported } = spec({ kind: 'vllm', overrides: { dry_multiplier: 0.8 } });

    expect(body.dry_multiplier).toBeUndefined();
    expect(unsupported).toContain('dry_multiplier');
  });

  it('reports a knob the registry has never heard of rather than sending it', () => {
    const { unsupported } = spec({ overrides: { made_up_sampler: 1 } });
    expect(unsupported).toContain('made_up_sampler');
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
    const { body } = spec({ turn: 'tool-turn', overrides: { frequency_penalty: 0.4 } });
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
