import { describe, it, expect } from 'vitest';
import { fittedMaxTokens, ASSUMED_CONTEXT_TOKENS, MIN_TURN_TOKENS, FILE_TURN_MAX_TOKENS } from './sampling.js';

/**
 * Does the request actually fit in the window?
 *
 * The engine allocates PROMPT + max_tokens before generating and refuses the pair outright if it
 * does not fit, so a ceiling that was fine on turn one is a hard 400 on turn twenty. Measured, and
 * self-inflicted: raising the file-writing ceiling to 8,000 made large writes possible and then
 * killed a leaf whose prompt had reached ~26,800 tokens —
 * "requires 34816 cache tokens, which exceeds the available context size of 32768". 26,816 + 8,000
 * is exactly 34,816.
 */
describe('fitting the reply into what is left', () => {
  it('reproduces the failure it was written for', () => {
    // ~26,800 tokens of prompt. The old code asked for the full 8,000 on top and was refused.
    const promptChars = 26_800 * 4;
    const fitted = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars);
    expect(promptChars / 4 + FILE_TURN_MAX_TOKENS).toBeGreaterThan(ASSUMED_CONTEXT_TOKENS);
    expect(promptChars / 4 + fitted).toBeLessThanOrEqual(ASSUMED_CONTEXT_TOKENS);
  });

  it('gives the whole ceiling when there is room', () => {
    // A short prompt must not be punished for a rule that exists for long ones.
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, 4_000)).toBe(FILE_TURN_MAX_TOKENS);
  });

  it('never goes below a floor worth generating', () => {
    /**
     * At this point the request is doomed either way, and a 12-token reply is a confusing failure
     * where a refused one is a clear one.
     */
    // Past 31,656 prompt tokens there is genuinely less than the floor left — 32,768 minus the
    // 512-token margin minus the floor itself.
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, 32_400 * 4)).toBe(MIN_TURN_TOKENS);
    // And just under that, it hands back what is actually available rather than the floor.
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, 31_000 * 4)).toBe(32_768 - 31_000 - 512);
  });

  it('holds across a growing conversation', () => {
    // The property that matters: every turn fits, not just the first.
    for (let promptTokens = 1_000; promptTokens < 30_000; promptTokens += 1_000) {
      const fitted = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptTokens * 4);
      if (fitted > MIN_TURN_TOKENS) {
        expect(promptTokens + fitted, `at ${promptTokens} prompt tokens`).toBeLessThanOrEqual(ASSUMED_CONTEXT_TOKENS);
      }
    }
  });
});
