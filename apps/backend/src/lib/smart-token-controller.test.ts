import { describe, it, expect } from 'vitest';
import { estimatePromptComplexity } from './smart-token-controller.js';

describe('smart-token-controller', () => {
  it('assigns casual tier for simple greetings', () => {
    const strategy = estimatePromptComplexity([{ role: 'user', content: "hows it going" }]);
    expect(strategy.tier).toBe('casual');
    expect(strategy.maxTokens).toBe(2048);
    expect(strategy.reasoningEffort).toBe('low');
  });

  it('assigns complex tier for explicit /plan mode', () => {
    const strategy = estimatePromptComplexity([{ role: 'user', content: 'plan the architecture' }], 'plan', true);
    expect(strategy.tier).toBe('complex');
    expect(strategy.maxTokens).toBe(16384);
    expect(strategy.reasoningEffort).toBe('high');
  });

  it('assigns complex tier for code blocks or deep questions', () => {
    const strategy = estimatePromptComplexity([
      { role: 'user', content: '```js\nfunction test() {}\n```\nCan you refactor this and implement error handling?' },
    ]);
    expect(strategy.tier).toBe('complex');
    expect(strategy.maxTokens).toBe(16384);
    expect(strategy.reasoningEffort).toBe('high');
  });

  it('assigns standard tier for general questions', () => {
    const strategy = estimatePromptComplexity([{ role: 'user', content: 'What is the capital of France?' }]);
    expect(strategy.tier).toBe('standard');
    expect(strategy.maxTokens).toBe(8192);
    expect(strategy.reasoningEffort).toBe('medium');
  });
});
