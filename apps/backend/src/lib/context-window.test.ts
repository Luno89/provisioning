import { describe, it, expect } from 'vitest';
import { providerFromDeployment } from './model-registry.js';
import { fittedMaxTokens, contextPressure, FALLBACK_CONTEXT_TOKENS, FILE_TURN_MAX_TOKENS } from './sampling.js';
import { conversationBudget, CONVERSATION_CHAR_BUDGET } from './sandbox-tools.js';
import type { DeploymentMetadata } from './types.js';

/**
 * ── THE CONSTANT THAT WAS READ AS A FACT ──
 *
 * Every budget in the harness was computed against a hardcoded 32,768 while the deployed engine
 * served 131,072 — a number the platform already stored on the deployment record and never read.
 * A Synthesist whose prompt reached 29,450 tokens was handed 2,806 tokens to generate a long
 * markdown document, with 101,110 actually free.
 *
 * The window belongs to the RUN, not the platform: a persona names its own model, so these must
 * resolve independently.
 */

const dep = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id: 'd1', name: 'Tabbyapi-Production', ownerId: 'u1', appType: 'tabbyapi', status: 'running',
  clusterId: 'c1', tabbyModel: 'turboderp/Qwen3.8-27B-exl3', tabbyMaxSeqLen: 131072,
  ...over,
} as DeploymentMetadata);

describe('where the window comes from', () => {
  it('reads what the engine was actually started with', () => {
    expect(providerFromDeployment(dep())?.contextTokens).toBe(131072);
  });

  it('reads the vLLM field for a vLLM deployment', () => {
    // Two engines, two field names — named in the catalogue so the loop never has to know.
    const vllm = dep({ appType: 'vllm', vllmModel: 'meta-llama/Llama-3.1-8B', vllmMaxModelLen: 8192 } as never);
    expect(providerFromDeployment(vllm)?.contextTokens).toBe(8192);
  });

  it('reports nothing rather than guessing when no window was recorded', () => {
    // Built without the field rather than with it set to undefined: `exactOptionalPropertyTypes`
    // treats those as different, and the real record simply lacks the key.
    /**
     * Absent is the honest answer for a deployment whose length nobody stored. A guess here would be
     * the same class of mistake as the constant this replaces — and the caller's fallback is
     * conservative, which fails small rather than failing the request outright.
     */
    const unknown = dep();
    delete (unknown as { tabbyMaxSeqLen?: number }).tabbyMaxSeqLen;
    expect(providerFromDeployment(unknown)?.contextTokens).toBeUndefined();
  });

  it('offers no window for a deployment that is not running', () => {
    expect(providerFromDeployment(dep({ status: 'failed' }))).toBeUndefined();
  });
});

describe('what the window changes', () => {
  // The Synthesist's real prompt, from its trace.
  const promptChars = 29_450 * 4;

  it('stops starving a leaf that has room', () => {
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, FALLBACK_CONTEXT_TOKENS)).toBe(2806);
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 131072)).toBe(FILE_TURN_MAX_TOKENS);
  });

  it('still refuses to overrun a genuinely small window', () => {
    // The original reason this function exists: the engine allocates prompt + max_tokens up front
    // and refuses the pair, before a token is generated. A bigger default must not lose that.
    const fitted = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 32_768);
    expect(29_450 + fitted).toBeLessThanOrEqual(32_768);
  });

  it('reports pressure against the same window it budgets against', () => {
    // These two drifted once by nobody watching the number at all; they must agree.
    expect(contextPressure(promptChars, FALLBACK_CONTEXT_TOKENS)).toBeGreaterThan(0.85);
    expect(contextPressure(promptChars, 131072)).toBeLessThan(0.3);
  });

  it('gives two personas on different models different budgets in one run', () => {
    // The property that makes many models at once possible.
    const big = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 131072);
    const small = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 32_768);
    expect(big).toBeGreaterThan(small);
  });
});

describe('how much of its own conversation a run may keep', () => {
  it('keeps exactly the old budget on the window it was fitted to', () => {
    // 60,000 chars was hand-fitted to 32,768. Deriving the proportion must not move it.
    expect(conversationBudget(FALLBACK_CONTEXT_TOKENS)).toBe(CONVERSATION_CHAR_BUDGET);
  });

  it('keeps more on a bigger window', () => {
    // Leaves were discarding history they had room for — a plausible contributor to the circling
    // that killed three Researchers, since an agent that forgets its searches repeats them.
    expect(conversationBudget(131072)).toBeGreaterThan(CONVERSATION_CHAR_BUDGET);
  });

  it('stops short of fully proportional by default', () => {
    /**
     * 131K proportional is ~240,000 chars. Prompt length changes every turn's cost, and the effect
     * of an agent remembering four times as much is unmeasured — so the default doubles, and the
     * rest is a tunable to be compared rather than assumed.
     */
    expect(conversationBudget(131072)).toBe(CONVERSATION_CHAR_BUDGET * 2);
    expect(conversationBudget(131072, 4)).toBeGreaterThan(CONVERSATION_CHAR_BUDGET * 2);
  });

  it('never keeps LESS than the old budget, whatever the window', () => {
    // A small model should keep what it always kept, not less.
    expect(conversationBudget(8192)).toBe(CONVERSATION_CHAR_BUDGET);
    expect(conversationBudget(undefined, 1)).toBe(CONVERSATION_CHAR_BUDGET);
  });
});
