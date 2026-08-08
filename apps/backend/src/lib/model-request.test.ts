/**
 * Every case here is a bug that shipped, typechecked, and passed the whole suite.
 *
 * They are all invisible without a live model: a field in the wrong place is accepted and ignored,
 * and a default that overwrites a profile looks exactly like a profile that was never set. That is
 * the argument for one builder rather than nine — and for pinning its behaviour here.
 */
import { describe, it, expect } from 'vitest';
import { buildModelRequest } from './model-request.js';

const spec = (over: Partial<Parameters<typeof buildModelRequest>[0]> = {}) => buildModelRequest({
  turn: 'conversation', kind: 'tabbyapi', messages: [{ role: 'user', content: 'hi' }],
  stream: true, maxTokens: 8192, ...over,
});

describe('precedence', () => {
  it('lets an override beat the built-in sampling', () => {
    /**
     * The regression, twice. Four chat sites spread `conversationSampling` LAST, so the adopted
     * profile's `frequency_penalty: 0` was overwritten by the built-in 0.4 on every turn — and
     * those penalties stop this model emitting a tool call, so chat returned empty replies.
     */
    const { body } = spec({ overrides: { frequency_penalty: 0, presence_penalty: 0 } });

    expect(body.frequency_penalty).toBe(0);
    expect(body.presence_penalty).toBe(0);
  });

  it('keeps the built-in where nothing overrode it', () => {
    const { body } = spec({ overrides: { temperature: 0.2 } });

    expect(body.temperature).toBe(0.2);
    expect(body.frequency_penalty).toBeGreaterThan(0);
  });

  it('never lets an override reach a transport field', () => {
    // `extra` is applied last on purpose: no registry knob names these, so nothing in the chain
    // can be trying to set them.
    const { body } = spec({ extra: { stream_options: { include_usage: true } } });
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('placement — where a knob lands on the wire', () => {
  it('nests a template_vars knob instead of sending it flat', () => {
    /**
     * `think` travels as `template_vars.enable_thinking`. The chat path filtered overrides by hand
     * and sent it as a top-level `think`, which the engine accepts, ignores, and runs with
     * reasoning in whatever state it defaulted to — a silent, total loss of the knob.
     */
    const { body } = spec({ overrides: { think: true } });

    expect(body.think).toBeUndefined();
    expect(body.template_vars).toMatchObject({ enable_thinking: true });
  });

  it('merges into template_vars rather than replacing what is there', () => {
    const { body } = spec({
      turn: 'tool-turn', overrides: { think: false },
    });
    // Whatever the base profile already nested has to survive a knob being written beside it.
    expect(body.template_vars).toMatchObject({ enable_thinking: false });
  });

  it('never transmits a knob the loop reads locally', () => {
    // maxSteps is a loop control. Sent to the model it is noise at best and a 400 at worst.
    const { body } = spec({ overrides: { maxSteps: 30 } });
    expect(body.maxSteps).toBeUndefined();
  });

  it('drops an engine-gated knob on the wrong engine, and says it did', () => {
    const { body, unsupported } = spec({ kind: 'vllm', overrides: { dry_multiplier: 0.8 } });

    expect(body.dry_multiplier).toBeUndefined();
    expect(unsupported).toContain('dry_multiplier');
  });

  it('reports a knob the registry has never heard of rather than sending it', () => {
    // Returned, not swallowed: a run records what it ASKED for beside what it sent.
    const { unsupported } = spec({ overrides: { made_up_sampler: 1 } });
    expect(unsupported).toContain('made_up_sampler');
  });
});

describe('the two kinds of turn', () => {
  it('gives a dispatch turn no repetition penalties', () => {
    // Measured 0/12 verified with them against 12/12 without: they do not degrade tool calling,
    // they eliminate it.
    const { body } = spec({ turn: 'tool-turn' });

    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
  });

  it('keeps them for a turn that produces prose for a human', () => {
    const { body } = spec({ turn: 'conversation' });
    expect(body.frequency_penalty).toBeGreaterThan(0);
  });

  it('still lets a dispatch turn be overridden back', () => {
    // The default is a default, not a policy.
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
    // An empty array is not the same as no tools: some engines read it as "you may call nothing".
    const { body } = spec({});
    expect('tools' in body).toBe(false);
  });

  it('sends the served model name when there is one', () => {
    const { body } = spec({ model: 'Qwen3-32B' });
    expect(body.model).toBe('Qwen3-32B');
  });
});
