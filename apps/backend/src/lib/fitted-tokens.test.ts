import { describe, it, expect } from 'vitest';
import { fittedMaxTokens, contextPressure } from './sampling.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

describe('fitting the reply into what is left', () => {
  it('reproduces the failure it was written for', () => {
    const promptChars = 26_800 * 4;
    const fitted = fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, promptChars);
    expect(promptChars / 4 + BUDGET.replyTokens.writingFiles).toBeGreaterThan(BUDGET.contextTokens);
    expect(promptChars / 4 + fitted).toBeLessThanOrEqual(BUDGET.contextTokens);
  });

  it('gives the whole ceiling when there is room', () => {
    expect(fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, 4_000)).toBe(BUDGET.replyTokens.writingFiles);
  });

  it('never goes below a floor worth generating', () => {
    expect(fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, 32_400 * 4)).toBe(BUDGET.minReplyTokens);
    expect(fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, 31_000 * 4)).toBe(32_768 - 31_000 - 512);
  });

  it('holds across a growing conversation', () => {
    for (let promptTokens = 1_000; promptTokens < 30_000; promptTokens += 1_000) {
      const fitted = fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, promptTokens * 4);
      if (fitted > BUDGET.minReplyTokens) {
        expect(promptTokens + fitted, `at ${promptTokens} prompt tokens`).toBeLessThanOrEqual(BUDGET.contextTokens);
      }
    }
  });
});

describe('seeing the window fill up before it is full', () => {
  it('rises with the prompt, and keeps rising past the point of no return', () => {
    const half = contextPressure(BUDGET, 16_000 * 4);
    const full = contextPressure(BUDGET, 32_000 * 4);
    const over = contextPressure(BUDGET, 48_000 * 4);

    expect(half).toBeLessThan(full);
    expect(full).toBeLessThan(over);
    expect(over).toBeGreaterThan(1);
  });

  it('reports roughly the fraction of the window a prompt occupies', () => {
    expect(contextPressure(BUDGET, 16_384 * 4)).toBeGreaterThan(0.5);
    expect(contextPressure(BUDGET, 16_384 * 4)).toBeLessThan(0.53);
  });

  it('leaves room for a full reply at the threshold Koala resets on', () => {
    const atThreshold = 0.55;
    const promptTokens = atThreshold * BUDGET.contextTokens;
    expect(promptTokens + 8_000).toBeLessThan(BUDGET.contextTokens);
    expect(fittedMaxTokens(BUDGET, 8_000, promptTokens * 4)).toBe(8_000);
  });
});
