/**
 * Smart Token Controller — Dynamic Token Budgeting & Automatic Continuation.
 *
 * Replaces hardcoded token limits with an intelligent, adaptive mechanism:
 *   1. Dynamic Prompt Complexity Estimator:
 *      Evaluates turn length, code blocks, system instructions, and mode (casual chat vs /plan)
 *      to dynamically allocate max_tokens (2048 for small talk up to 16384 for deep planning)
 *      and sets reasoning_effort ('low', 'medium', 'high').
 *
 *   2. Automatic Continuation Pass (finish_reason === 'length'):
 *      Tracks finish_reason across SSE chunks. If a hard problem or deep reasoning pass runs out of
 *      completion tokens mid-thought (finish_reason: 'length'), the backend automatically triggers
 *      a continuation pass to stream the remaining response seamlessly without truncating.
 */

export interface TokenStrategy {
  tier: 'casual' | 'standard' | 'complex';
  maxTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high';
}

/**
 * Evaluates conversation history and turn characteristics to assign an adaptive token strategy.
 */
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

  // Casual greetings / small talk (under 8 words, no code, common pleasantries)
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

/**
 * Scans an SSE stream for choice finish_reason (e.g., 'stop', 'length', 'tool_calls').
 */
export class FinishReasonScanner {
  private buffer = '';
  private finishReason: string | undefined;

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const reason = JSON.parse(payload)?.choices?.[0]?.finish_reason;
        if (typeof reason === 'string' && reason) {
          this.finishReason = reason;
        }
      } catch {
        // Partial or non-JSON frames are normal mid-stream.
      }
    }
  }

  result(): string | undefined {
    return this.finishReason;
  }
}
