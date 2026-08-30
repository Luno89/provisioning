import { describe, it, expect } from 'vitest';
import { providerFromDeployment } from './model-registry.js';
import { fittedMaxTokens, contextPressure } from './sampling.js';
import { conversationBudget } from './sandbox-tools.js';
import type { DeploymentMetadata } from './types.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

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
    expect(fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, promptChars, BUDGET.contextTokens)).toBe(2806);
    expect(fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, promptChars, 131072)).toBe(BUDGET.replyTokens.writingFiles);
  });

  it('still refuses to overrun a genuinely small window', () => {
    const fitted = fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, promptChars, 32_768);
    expect(29_450 + fitted).toBeLessThanOrEqual(32_768);
  });

  it('reports pressure against the same window it budgets against', () => {
    expect(contextPressure(BUDGET, promptChars, BUDGET.contextTokens)).toBeGreaterThan(0.85);
    expect(contextPressure(BUDGET, promptChars, 131072)).toBeLessThan(0.3);
  });

  it('gives two personas on different models different budgets in one run', () => {
    const big = fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, promptChars, 131072);
    const small = fittedMaxTokens(BUDGET, BUDGET.replyTokens.writingFiles, promptChars, 32_768);
    expect(big).toBeGreaterThan(small);
  });
});

describe('how much of its own conversation a run may keep', () => {
  it('keeps exactly the old budget on the window it was fitted to', () => {
    expect(conversationBudget(BUDGET, BUDGET.contextTokens)).toBe(BUDGET.conversationChars);
  });

  it('keeps more on a bigger window', () => {
    expect(conversationBudget(BUDGET, 131072)).toBeGreaterThan(BUDGET.conversationChars);
  });

  it('stops short of fully proportional by default', () => {
    expect(conversationBudget(BUDGET, 131072)).toBe(BUDGET.conversationChars * 2);
    expect(conversationBudget(BUDGET, 131072, 4)).toBeGreaterThan(BUDGET.conversationChars * 2);
  });

  it('never keeps LESS than the old budget, whatever the window', () => {
    expect(conversationBudget(BUDGET, 8192)).toBe(BUDGET.conversationChars);
    expect(conversationBudget(BUDGET, undefined, 1)).toBe(BUDGET.conversationChars);
  });
});
