import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens } from './token-estimator.js';
import { calculatePressure, remainingHeadroom, fitReplyCeiling, evalCompactionPhase } from './context-budget.js';

describe('token estimation', () => {
  it('handles empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('accurately estimates code and json containing punctuation', () => {
    const json = '{"key": "value", "arr": [1, 2, 3], "nested": {"a": true}}';
    const count = estimateTokens(json);
    expect(count).toBeGreaterThan(15);
    expect(count).toBeLessThan(50);
  });

  it('estimates message overhead accurately', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const tokens = estimateMessageTokens(messages);
    expect(tokens).toBeGreaterThan(10);
  });
});

describe('context budget and pressure calculations', () => {
  const params = { windowTokens: 32_000, marginTokens: 512, minReplyTokens: 512 };

  it('calculates pressure accurately', () => {
    const pressure = calculatePressure(16_000, params);
    expect(pressure).toBeCloseTo((16_000 + 512) / 32_000, 2);
  });

  it('calculates remaining headroom and fits reply ceiling', () => {
    const headroom = remainingHeadroom(30_000, params);
    expect(headroom).toBe(32_000 - 30_000 - 512);

    const ceiling = fitReplyCeiling(4000, 30_000, params);
    expect(ceiling).toBe(headroom);
  });

  it('evaluates compaction phases discretely', () => {
    const cfg = { softThreshold: 0.65, hardThreshold: 0.78, criticalThreshold: 0.90 };
    expect(evalCompactionPhase(0.50, cfg)).toBe('normal');
    expect(evalCompactionPhase(0.68, cfg)).toBe('soft_mask');
    expect(evalCompactionPhase(0.80, cfg)).toBe('hard_compact');
    expect(evalCompactionPhase(0.92, cfg)).toBe('critical_reset');
  });
});
