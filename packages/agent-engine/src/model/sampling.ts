import type { BudgetConfig } from '@koala/harness-types';

export const NO_THINKING = { template_vars: { enable_thinking: false } } as const;

/**
 * The ceiling, cut down to what is actually left in the window. `contextTokens` is what the endpoint
 * reports; the pack's value is the fallback for an endpoint that reports nothing.
 */
export function fittedMaxTokens(
  budget: BudgetConfig,
  ceiling: number,
  promptChars: number,
  contextTokens?: number,
): number {
  const window = contextTokens ?? budget.contextTokens;
  const promptTokens = Math.ceil(promptChars / 4);
  const available = window - promptTokens - budget.contextMargin;
  return Math.max(budget.minReplyTokens, Math.min(ceiling, available));
}

export function contextPressure(
  budget: BudgetConfig,
  promptChars: number,
  contextTokens?: number,
): number {
  const window = contextTokens ?? budget.contextTokens;
  const promptTokens = Math.ceil(promptChars / 4);
  return (promptTokens + budget.contextMargin) / window;
}

