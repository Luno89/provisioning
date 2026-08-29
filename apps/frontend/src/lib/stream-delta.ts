
export interface StreamDelta {
  content: string;
  reasoning: string;
  interruptedReason?: string;
}

export function consumeChunk(buffer: string, chunk: string): { buffer: string; delta: StreamDelta } {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  const remainder = lines.pop() ?? '';

  const delta: StreamDelta = { content: '', reasoning: '' };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed.interruptedReason === 'string' && parsed.interruptedReason) {
        delta.interruptedReason = parsed.interruptedReason;
      }
      const d = parsed.choices?.[0]?.delta ?? {};
      const reasoningText =
        (typeof d.reasoning_content === 'string' ? d.reasoning_content : '') ||
        (typeof d.reasoning === 'string' ? d.reasoning : '') ||
        (typeof d.thinking === 'string' ? d.thinking : '');

      if (reasoningText) delta.reasoning += reasoningText;
      if (typeof d.content === 'string') delta.content += d.content;
    } catch {
    }
  }
  return { buffer: remainder, delta };
}

export function splitThinkTags(text: string): { content: string; reasoning: string } {
  if (!text.includes('<think>')) {
    return { content: text, reasoning: '' };
  }
  let reasoning = '';
  let content = '';
  let cursor = 0;
  while (cursor < text.length) {
    const thinkStart = text.indexOf('<think>', cursor);
    if (thinkStart === -1) {
      content += text.slice(cursor);
      break;
    }
    content += text.slice(cursor, thinkStart);
    const thinkEnd = text.indexOf('</think>', thinkStart + 7);
    if (thinkEnd === -1) {
      reasoning += text.slice(thinkStart + 7);
      break;
    }
    reasoning += text.slice(thinkStart + 7, thinkEnd);
    cursor = thinkEnd + 8;
  }
  return { content, reasoning };
}
