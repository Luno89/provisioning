
export interface TokenStrategy {
  tier: 'casual' | 'standard' | 'complex';
  maxTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high';
}

export function estimatePromptComplexity(
  messages: Array<{ role: string; content?: string }>,
  mode?: string,
  explicitPlan?: boolean
): TokenStrategy {
  if (explicitPlan || mode === 'plan') {
    return { tier: 'complex', maxTokens: 16384, reasoningEffort: 'high' };
  }

  const lastMessage = messages[messages.length - 1]?.content ?? '';
  const trimmed = lastMessage.trim().toLowerCase();

  const isCasual =
    trimmed.length < 50 &&
    !trimmed.includes('```') &&
    /^(hi|hello|hey|hows it going|how's it going|how are you|sup|good morning|good evening)\b/.test(trimmed);

  if (isCasual) {
    return { tier: 'casual', maxTokens: 2048, reasoningEffort: 'low' };
  }

  // Complex tasks: code blocks, multi-step requests, long prompts (> 250 chars)
  const isComplex =
    trimmed.includes('```') ||
    trimmed.length > 250 ||
    /refactor|implement|architect|design|debug|solve|calculate|compare|explain in detail/i.test(trimmed);

  if (isComplex) {
    return { tier: 'complex', maxTokens: 16384, reasoningEffort: 'high' };
  }

  return { tier: 'standard', maxTokens: 8192, reasoningEffort: 'medium' };
}
