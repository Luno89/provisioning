import { describe, it, expect } from 'vitest';
import {
  toolTurnSampling,
  conversationSampling,
  NO_THINKING,
  TOOL_TURN_MAX_TOKENS,
  TOOL_DISCIPLINE_PROMPT,
} from './sampling.js';

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

  it('guards a CONVERSATION turn against repetition, whatever the engine', () => {
    for (const kind of ['tabbyapi', 'vllm', undefined] as const) {
      expect(conversationSampling(kind).frequency_penalty).toBeGreaterThan(0);
    }
  });

  it('never penalises repetition on a turn that has to call a tool', () => {
    for (const kind of ['tabbyapi', 'vllm', undefined] as const) {
      expect(toolTurnSampling(kind).frequency_penalty).toBeUndefined();
      expect(toolTurnSampling(kind).presence_penalty).toBeUndefined();
    }
  });

  it('keeps DRY on a tool turn, which was measured innocent', () => {
    expect(toolTurnSampling('tabbyapi')).toHaveProperty('dry_multiplier');
  });
});

describe('what each kind of turn gets', () => {
  it('picks tools at a low temperature — choosing a tool is not a creative act', () => {
    expect(toolTurnSampling('tabbyapi').temperature).toBeLessThanOrEqual(0.3);
  });

  it('leaves conversation temperature alone, so the caller stays in charge', () => {
    expect(conversationSampling('tabbyapi')).not.toHaveProperty('temperature');
  });

  it('nests enable_thinking under template_vars, where it is actually read', () => {
    expect(NO_THINKING).toEqual({ template_vars: { enable_thinking: false } });
  });

  it('caps a dispatch turn well below a conversational budget', () => {
    expect(TOOL_TURN_MAX_TOKENS).toBeLessThan(2000);
  });
});

describe('TOOL_DISCIPLINE_PROMPT', () => {
  it('forbids inventing a tool result, which is the observed failure', () => {
    expect(TOOL_DISCIPLINE_PROMPT).toMatch(/never invent/i);
    expect(TOOL_DISCIPLINE_PROMPT).toMatch(/call the tool and stop/i);
  });

  it('tells it not to deliberate about formatting', () => {
    expect(TOOL_DISCIPLINE_PROMPT).toMatch(/formatting/i);
  });
});
