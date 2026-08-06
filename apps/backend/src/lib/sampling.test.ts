import { describe, it, expect } from 'vitest';
import {
  toolTurnSampling,
  conversationSampling,
  NO_THINKING,
  TOOL_TURN_MAX_TOKENS,
  TOOL_DISCIPLINE_PROMPT,
} from './sampling.js';

/**
 * These guard a portability rule as much as a behavioural one.
 *
 * This platform talks to any OpenAI-compatible endpoint — OpenAI itself, or whatever a user
 * registers over the mesh. Sending an exllama-only sampler to a strict server earns a 400, which
 * would turn loop PREVENTION into an outage for every user on a different engine.
 */
describe('sampler portability', () => {
  const OPENAI_STANDARD = ['temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'max_tokens'];

  it('sends only standard OpenAI fields when the engine is unknown', () => {
    for (const settings of [toolTurnSampling(undefined), conversationSampling(undefined)]) {
      for (const key of Object.keys(settings)) expect(OPENAI_STANDARD).toContain(key);
    }
  });

  it('sends DRY only to TabbyAPI, which is the engine that has it', () => {
    expect(toolTurnSampling('tabbyapi')).toHaveProperty('dry_multiplier');
    expect(toolTurnSampling('vllm')).not.toHaveProperty('dry_multiplier');
    expect(toolTurnSampling(undefined)).not.toHaveProperty('dry_multiplier');
  });

  it('always applies a repetition guard, whatever the engine', () => {
    // The observed failure was forty identical lines. That is a decoding pathology, and every
    // engine gets at least the portable defence against it.
    for (const kind of ['tabbyapi', 'vllm', undefined] as const) {
      expect(conversationSampling(kind).frequency_penalty).toBeGreaterThan(0);
      expect(toolTurnSampling(kind).frequency_penalty).toBeGreaterThan(0);
    }
  });
});

describe('what each kind of turn gets', () => {
  it('picks tools at a low temperature — choosing a tool is not a creative act', () => {
    expect(toolTurnSampling('tabbyapi').temperature).toBeLessThanOrEqual(0.3);
  });

  it('leaves conversation temperature alone, so the caller stays in charge', () => {
    // Reasoning and its temperature are what make the chat worth having; only the decoding
    // pathology is suppressed here.
    expect(conversationSampling('tabbyapi')).not.toHaveProperty('temperature');
  });

  it('nests enable_thinking under template_vars, where it is actually read', () => {
    // At the top level it is silently ignored and the model produces garbage — confirmed live,
    // it emitted Chinese mid-sentence.
    expect(NO_THINKING).toEqual({ template_vars: { enable_thinking: false } });
  });

  it('caps a dispatch turn well below a conversational budget', () => {
    expect(TOOL_TURN_MAX_TOKENS).toBeLessThan(2000);
  });
});

describe('TOOL_DISCIPLINE_PROMPT', () => {
  it('forbids inventing a tool result, which is the observed failure', () => {
    // The model wrote a plausible list_projects RESULT into its own reasoning, believed it, then
    // spent the rest of the turn discovering it had made the data up.
    expect(TOOL_DISCIPLINE_PROMPT).toMatch(/never invent/i);
    expect(TOOL_DISCIPLINE_PROMPT).toMatch(/call the tool and stop/i);
  });

  it('tells it not to deliberate about formatting', () => {
    expect(TOOL_DISCIPLINE_PROMPT).toMatch(/formatting/i);
  });
});
