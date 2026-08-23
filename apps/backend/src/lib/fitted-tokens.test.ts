import { describe, it, expect } from 'vitest';
import {
  fittedMaxTokens, contextPressure, FALLBACK_CONTEXT_TOKENS, MIN_TURN_TOKENS, FILE_TURN_MAX_TOKENS,
} from './sampling.js';

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
    expect(promptChars / 4 + FILE_TURN_MAX_TOKENS).toBeGreaterThan(FALLBACK_CONTEXT_TOKENS);
    expect(promptChars / 4 + fitted).toBeLessThanOrEqual(FALLBACK_CONTEXT_TOKENS);
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
        expect(promptTokens + fitted, `at ${promptTokens} prompt tokens`).toBeLessThanOrEqual(FALLBACK_CONTEXT_TOKENS);
      }
    }
  });
});

/**
 * The signal `fittedMaxTokens` cannot give, because it floors.
 *
 * Once the prompt passes the window, `fittedMaxTokens` returns MIN_TURN_TOKENS and keeps returning
 * it however much further past the edge the prompt goes — so the number stops moving exactly when
 * the trouble starts, and the caller happily asks the engine for a prompt that does not fit plus
 * 600 more. `contextPressure` is unfloored so a caller can see it coming.
 */
describe('seeing the window fill up before it is full', () => {
  it('rises with the prompt, and keeps rising past the point of no return', () => {
    const half = contextPressure(16_000 * 4);
    const full = contextPressure(32_000 * 4);
    const over = contextPressure(48_000 * 4);

    expect(half).toBeLessThan(full);
    expect(full).toBeLessThan(over);
    // The whole point: past the window it still reports how far past, rather than saturating.
    expect(over).toBeGreaterThan(1);
  });

  it('reports roughly the fraction of the window a prompt occupies', () => {
    // Half the window, give or take the framing margin the engine needs.
    expect(contextPressure(16_384 * 4)).toBeGreaterThan(0.5);
    expect(contextPressure(16_384 * 4)).toBeLessThan(0.53);
  });

  /**
   * The threshold Koala resets at has to leave room for a full reply, not just for the prompt.
   * KOALA_MAX_TOKENS is 8,000 — 24% of the window on its own — so a prompt at 0.55 plus a full
   * reply is already ~0.79. Resetting at 0.95 would mean the recovery does not fit either.
   */
  it('leaves room for a full reply at the threshold Koala resets on', () => {
    const atThreshold = 0.55;
    const promptTokens = atThreshold * FALLBACK_CONTEXT_TOKENS;
    expect(promptTokens + 8_000).toBeLessThan(FALLBACK_CONTEXT_TOKENS);
    // And the reply budget there is still the full ceiling, not a shrunken one.
    expect(fittedMaxTokens(8_000, promptTokens * 4)).toBe(8_000);
  });
});
