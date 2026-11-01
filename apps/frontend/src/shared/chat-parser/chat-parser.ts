
export interface ParsedChatMessage {
  thoughts: string[];
  isThinking: boolean;
  cleanContent: string;
  toolCalls: { name: string; args: string }[];
}

function toolCallOf(body: string): { name: string; args: string } | 'not-json' | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim() || '{}');
  } catch {
    return 'not-json';
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { name, arguments: args } = parsed as { name?: unknown; arguments?: unknown };
  if (!name) return undefined;
  return { name: String(name), args: typeof args === 'string' ? args : JSON.stringify(args || {}) };
}

export class ChatParser {
  private static readonly CONTROL_TOKENS = [
    /<\|im_start\|>/gi,
    /<\|im_end\|>/gi,
    /<\|eot_id\|>/gi,
    /<\|endoftext\|>/gi,
    /<s>/gi,
    /<\/s>/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /<\|start_header_id\|>.*?<\|end_header_id\|>/gi,
  ];

  static stripControlTokens(text: string): string {
    let result = text;
    for (const pattern of this.CONTROL_TOKENS) {
      result = result.replace(pattern, '');
    }
    return result;
  }

  static extractThoughts(text: string): { thoughts: string[]; isThinking: boolean; cleanContent: string } {
    const thoughts: string[] = [];
    let isThinking = false;
    let cleanContent = text;

    const closedThinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    let match: RegExpExecArray | null;
    while ((match = closedThinkRegex.exec(text)) !== null) {
      const thoughtText = match[1]?.trim();
      if (thoughtText) {
        thoughts.push(thoughtText);
      }
    }
    cleanContent = cleanContent.replace(closedThinkRegex, '').trim();

    const openThinkIndex = cleanContent.lastIndexOf('<think>');
    if (openThinkIndex !== -1) {
      const openThoughtText = cleanContent.slice(openThinkIndex + 7).trim();
      if (openThoughtText) {
        thoughts.push(openThoughtText);
      }
      isThinking = true;
      cleanContent = cleanContent.slice(0, openThinkIndex).trim();
    }

    const bracketThoughtRegex = /\[THOUGHT\]([\s\S]*?)\[\/THOUGHT\]/gi;
    while ((match = bracketThoughtRegex.exec(cleanContent)) !== null) {
      const thoughtText = match[1]?.trim();
      if (thoughtText) {
        thoughts.push(thoughtText);
      }
    }
    cleanContent = cleanContent.replace(bracketThoughtRegex, '').trim();

    return { thoughts, isThinking, cleanContent };
  }

  static normalizeAlerts(text: string): string {
    return text.replace(
      /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:^>.*(?:\n|$))*)/gim,
      (_match: string, type: string, body: string) => {
        const cleanBody = body
          .split('\n')
          .map((line: string) => line.replace(/^>\s?/, ''))
          .join('\n')
          .trim();
        return `\n:::alert{type="${type.toLowerCase()}"}\n${cleanBody}\n:::\n`;
      },
    );
  }

  static extractToolCalls(text: string): { toolCalls: { name: string; args: string }[]; cleanContent: string } {
    const toolCalls: { name: string; args: string }[] = [];
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;

    const cleanContent = text.replace(toolCallRegex, (whole: string, body: string) => {
      const call = toolCallOf(body);
      if (call === 'not-json') return whole;
      if (call) toolCalls.push(call);
      return '';
    }).trim();
    return { toolCalls, cleanContent };
  }

  static asWritten(text: string): ParsedChatMessage {
    return { thoughts: [], isThinking: false, cleanContent: text, toolCalls: [] };
  }

  static parse(rawMessage: string): ParsedChatMessage {
    if (!rawMessage) {
      return { thoughts: [], isThinking: false, cleanContent: '', toolCalls: [] };
    }

    const stripped = this.stripControlTokens(rawMessage);

    const { thoughts, isThinking, cleanContent: afterThoughts } = this.extractThoughts(stripped);

    const { toolCalls, cleanContent: afterTools } = this.extractToolCalls(afterThoughts);

    return {
      thoughts,
      isThinking,
      cleanContent: afterTools,
      toolCalls,
    };
  }
}
