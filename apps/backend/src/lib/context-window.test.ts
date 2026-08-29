import { describe, it, expect } from 'vitest';
import { providerFromDeployment } from './model-registry.js';
import { fittedMaxTokens, contextPressure, FALLBACK_CONTEXT_TOKENS, FILE_TURN_MAX_TOKENS } from './sampling.js';
import { conversationBudget, CONVERSATION_CHAR_BUDGET } from './sandbox-tools.js';
import type { DeploymentMetadata } from './types.js';

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
    const vllm = dep({ appType: 'vllm', vllmModel: 'meta-llama/Llama-3.1-8B', vllmMaxModelLen: 8192 } as never);
    expect(providerFromDeployment(vllm)?.contextTokens).toBe(8192);
  });

  it('reports nothing rather than guessing when no window was recorded', () => {
    const unknown = dep();
    delete (unknown as { tabbyMaxSeqLen?: number }).tabbyMaxSeqLen;
    expect(providerFromDeployment(unknown)?.contextTokens).toBeUndefined();
  });

  it('offers no window for a deployment that is not running', () => {
    expect(providerFromDeployment(dep({ status: 'failed' }))).toBeUndefined();
  });
});

describe('what the window changes', () => {
  const promptChars = 29_450 * 4;

  it('stops starving a leaf that has room', () => {
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, FALLBACK_CONTEXT_TOKENS)).toBe(2806);
    expect(fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 131072)).toBe(FILE_TURN_MAX_TOKENS);
  });

  it('still refuses to overrun a genuinely small window', () => {
    const fitted = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 32_768);
    expect(29_450 + fitted).toBeLessThanOrEqual(32_768);
  });

  it('reports pressure against the same window it budgets against', () => {
    expect(contextPressure(promptChars, FALLBACK_CONTEXT_TOKENS)).toBeGreaterThan(0.85);
    expect(contextPressure(promptChars, 131072)).toBeLessThan(0.3);
  });

  it('gives two personas on different models different budgets in one run', () => {
    const big = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 131072);
    const small = fittedMaxTokens(FILE_TURN_MAX_TOKENS, promptChars, 32_768);
    expect(big).toBeGreaterThan(small);
  });
});

describe('how much of its own conversation a run may keep', () => {
  it('keeps exactly the old budget on the window it was fitted to', () => {
    expect(conversationBudget(FALLBACK_CONTEXT_TOKENS)).toBe(CONVERSATION_CHAR_BUDGET);
  });

  it('keeps more on a bigger window', () => {
    expect(conversationBudget(131072)).toBeGreaterThan(CONVERSATION_CHAR_BUDGET);
  });

  it('stops short of fully proportional by default', () => {
    expect(conversationBudget(131072)).toBe(CONVERSATION_CHAR_BUDGET * 2);
    expect(conversationBudget(131072, 4)).toBeGreaterThan(CONVERSATION_CHAR_BUDGET * 2);
  });

  it('never keeps LESS than the old budget, whatever the window', () => {
    expect(conversationBudget(8192)).toBe(CONVERSATION_CHAR_BUDGET);
    expect(conversationBudget(undefined, 1)).toBe(CONVERSATION_CHAR_BUDGET);
  });
});
