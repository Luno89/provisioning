import { describe, it, expect } from 'vitest';
import {
  fittedMaxTokens, contextPressure, FALLBACK_CONTEXT_TOKENS, MIN_TURN_TOKENS, FILE_TURN_MAX_TOKENS,
} from './sampling.js';

describe('fitting the reply into what is left', () => {
  it('reproduces the failure it was written for', () => {
    const promptChars = 26_800 * 4;
    const fitted = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars);
    expect(promptChars / 4 + FILE_TURN_MAX_TOKENS).toBeGreaterThan(FALLBACK_CONTEXT_TOKENS);
    expect(promptChars / 4 + fitted).toBeLessThanOrEqual(FALLBACK_CONTEXT_TOKENS);
  });

  it('gives the whole ceiling when there is room', () => {
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, 4_000)).toBe(FILE_TURN_MAX_TOKENS);
  });

  it('never goes below a floor worth generating', () => {
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, 32_400 * 4)).toBe(MIN_TURN_TOKENS);
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, 31_000 * 4)).toBe(32_768 - 31_000 - 512);
  });

  it('holds across a growing conversation', () => {
    for (let promptTokens = 1_000; promptTokens < 30_000; promptTokens += 1_000) {
      const fitted = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptTokens * 4);
      if (fitted > MIN_TURN_TOKENS) {
        expect(promptTokens + fitted, `at ${promptTokens} prompt tokens`).toBeLessThanOrEqual(FALLBACK_CONTEXT_TOKENS);
      }
    }
  });
});

describe('seeing the window fill up before it is full', () => {
  it('rises with the prompt, and keeps rising past the point of no return', () => {
    const half = contextPressure(16_000 * 4);
    const full = contextPressure(32_000 * 4);
    const over = contextPressure(48_000 * 4);

    expect(half).toBeLessThan(full);
    expect(full).toBeLessThan(over);
    expect(over).toBeGreaterThan(1);
  });

  it('reports roughly the fraction of the window a prompt occupies', () => {
    expect(contextPressure(16_384 * 4)).toBeGreaterThan(0.5);
    expect(contextPressure(16_384 * 4)).toBeLessThan(0.53);
  });

  it('leaves room for a full reply at the threshold Koala resets on', () => {
    const atThreshold = 0.55;
    const promptTokens = atThreshold * FALLBACK_CONTEXT_TOKENS;
    expect(promptTokens + 8_000).toBeLessThan(FALLBACK_CONTEXT_TOKENS);
    expect(fittedMaxTokens(8_000, promptTokens * 4)).toBe(8_000);
  });
});
