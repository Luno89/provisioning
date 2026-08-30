import type { ModelKind } from './model-registry.js';

export const NO_THINKING = { template_vars: { enable_thinking: false } } as const;

export const TOOL_TURN_MAX_TOKENS = 800;

export const THINKING_TURN_MAX_TOKENS = 2000;

export const FILE_TURN_MAX_TOKENS = 8000;

export function turnMaxTokens(opts: { think?: boolean; canWriteFiles?: boolean }): number {
  if (opts.canWriteFiles) return Math.max(FILE_TURN_MAX_TOKENS, opts.think ? THINKING_TURN_MAX_TOKENS : 0);
  return opts.think ? THINKING_TURN_MAX_TOKENS : TOOL_TURN_MAX_TOKENS;
}

export const FALLBACK_CONTEXT_TOKENS = 32_768;

const CONTEXT_MARGIN_TOKENS = 512;

export const MIN_TURN_TOKENS = 600;

export function fittedMaxTokens(ceiling: number, promptChars: number, contextTokens = FALLBACK_CONTEXT_TOKENS): number {
  const promptTokens = Math.ceil(promptChars / 4);
  const available = contextTokens - promptTokens - CONTEXT_MARGIN_TOKENS;
  return Math.max(MIN_TURN_TOKENS, Math.min(ceiling, available));
}

export function contextPressure(promptChars: number, contextTokens = FALLBACK_CONTEXT_TOKENS): number {
  const promptTokens = Math.ceil(promptChars / 4);
  return (promptTokens + CONTEXT_MARGIN_TOKENS) / contextTokens;
}

export const TOOL_DISCIPLINE_PROMPT = [
  'Never invent, predict, or write out a tool result. If you need data, call the tool and stop —',
  'the result will be given to you in the next turn. Do not deliberate about output formatting;',
  'call the tool directly.',
].join('\n');
