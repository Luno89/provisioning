/**
 * Fast, BPE-aware token estimator for coding agents.
 *
 * Plain text averages ~4 characters per token, but code, JSON, and punctuation-dense
 * structures average ~2.5 - 3.2 characters per token because delimiters and operators
 * map to single tokens. Naive chars/4 heuristic underestimates tokens in JSON/code by 30-50%,
 * leading to unexpected context overflows.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Split into tokens using a BPE-approximating regex:
  // - Matches code punctuation & delimiters separately
  // - Handles camelCase and snake_case word boundaries
  // - Handles number sequences and whitespace chunks
  const pattern = /[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\b)|[0-9]+|[\s]+|[^\s\w]/g;
  const matches = text.match(pattern);
  if (!matches) return Math.ceil(text.length / 3.5);

  let tokens = 0;
  for (const piece of matches) {
    const len = piece.length;
    if (/^\s+$/.test(piece)) {
      // Whitespace runs: 1 token per 4 spaces or per newline
      tokens += Math.max(1, Math.floor(len / 4));
    } else if (/^[^\s\w]$/.test(piece)) {
      // Single punctuation symbols ({}, [], (), ;:, etc.) are 1 token each
      tokens += 1;
    } else if (/^[0-9]+$/.test(piece)) {
      // Numbers: roughly 1 token per 2.5 digits
      tokens += Math.ceil(len / 3);
    } else {
      // Words: subword chunking for long words
      tokens += Math.max(1, Math.ceil(len / 4.2));
    }
  }

  return Math.max(1, tokens);
}

/**
 * Estimates token count for an array of arbitrary message objects or string content.
 */
export function estimateMessageTokens(messages: readonly { role?: string | undefined; content?: unknown; tool_calls?: unknown }[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // Per-message framing overhead in ChatML / Anthropic / OpenAI formats
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
    } else if (m.content && typeof m.content === 'object') {
      total += estimateTokens(JSON.stringify(m.content));
    }
    if (m.tool_calls) {
      total += estimateTokens(JSON.stringify(m.tool_calls));
    }
  }
  total += 3; // Conversation primer overhead
  return total;
}
