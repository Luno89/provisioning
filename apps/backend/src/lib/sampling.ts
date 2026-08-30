import type { ModelKind } from './model-registry.js';
import type { BudgetConfig } from '@koala/harness-types';

export const NO_THINKING = { template_vars: { enable_thinking: false } } as const;

/** What one turn may reply with, given what that turn is for. The caps are the pack's. */
export function turnMaxTokens(
  replyTokens: BudgetConfig['replyTokens'],
  opts: { think?: boolean; canWriteFiles?: boolean },
): number {
  if (opts.canWriteFiles) {
    return Math.max(replyTokens.writingFiles, opts.think ? replyTokens.thinking : 0);
  }
  return opts.think ? replyTokens.thinking : replyTokens.tool;
}

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

export const TOOL_DISCIPLINE_PROMPT = [
  'Never invent, predict, or write out a tool result. If you need data, call the tool and stop —',
  'the result will be given to you in the next turn. Do not deliberate about output formatting;',
  'call the tool directly.',
].join('\n');
