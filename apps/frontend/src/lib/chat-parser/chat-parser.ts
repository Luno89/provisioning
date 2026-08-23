/**
 * High-performance, multi-stage Chat Parser for LLM stream and response processing.
 *
 * Handles:
 * 1. DeepSeek / Qwen `<think>...</think>` thought tag extraction (including streaming unclosed tags).
 * 2. Control token stripping (<|im_start|>, <|im_end|>, <|eot_id|>, <s>, </s>, [INST], [/INST]).
 * 3. GitHub-style callouts/alerts (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]).
 * 4. Special tool call & artifact block extraction.
 */

export interface ParsedChatMessage {
  thoughts: string[];
  isThinking: boolean;
  cleanContent: string;
  toolCalls: { name: string; args: string }[];
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

  /**
   * Strips LLM internal control tokens.
   */
  static stripControlTokens(text: string): string {
    let result = text;
    for (const pattern of this.CONTROL_TOKENS) {
      result = result.replace(pattern, '');
    }
    return result;
  }

  /**
   * Extracts `<think>...</think>` tags and returns separated thoughts and body content.
   * Handles both completed and in-progress streaming `<think>` tags.
   */
  static extractThoughts(text: string): { thoughts: string[]; isThinking: boolean; cleanContent: string } {
    const thoughts: string[] = [];
    let isThinking = false;
    let cleanContent = text;

    // 1. Extract closed <think>...</think> blocks
    const closedThinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    let match: RegExpExecArray | null;
    while ((match = closedThinkRegex.exec(text)) !== null) {
      const thoughtText = match[1]?.trim();
      if (thoughtText) {
        thoughts.push(thoughtText);
      }
    }
    cleanContent = cleanContent.replace(closedThinkRegex, '').trim();

    // 2. Check for open unclosed <think> tag (streaming in progress)
    const openThinkIndex = cleanContent.lastIndexOf('<think>');
    if (openThinkIndex !== -1) {
      const openThoughtText = cleanContent.slice(openThinkIndex + 7).trim();
      if (openThoughtText) {
        thoughts.push(openThoughtText);
      }
      isThinking = true;
      cleanContent = cleanContent.slice(0, openThinkIndex).trim();
    }

    // Also support [THOUGHT]...[/THOUGHT]
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

  /**
   * Normalizes GitHub alerts / callouts.
   */
  static normalizeAlerts(text: string): string {
    return text.replace(
      /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n((?:^>.*(?:\n|$))*)/gim,
      (_match, type, body) => {
        const cleanBody = body
          .split('\n')
          .map((line: string) => line.replace(/^>\s?/, ''))
          .join('\n')
          .trim();
        return `\n:::alert{type="${type.toLowerCase()}"}\n${cleanBody}\n:::\n`;
      },
    );
  }

  /**
   * Extracts embedded tool calls e.g. <tool_call>{"name":"...","arguments":{}}</tool_call>
   */
  static extractToolCalls(text: string): { toolCalls: { name: string; args: string }[]; cleanContent: string } {
    const toolCalls: { name: string; args: string }[] = [];
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;

    let match: RegExpExecArray | null;
    while ((match = toolCallRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]?.trim() || '{}');
        if (parsed.name) {
          toolCalls.push({
            name: parsed.name,
            args: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {}),
          });
        }
      } catch {
        // Keep raw text if not valid JSON
      }
    }

    const cleanContent = text.replace(toolCallRegex, '').trim();
    return { toolCalls, cleanContent };
  }

  /**
   * Master pipeline function: cleans, parses, and structures LLM message content.
   */
  static parse(rawMessage: string): ParsedChatMessage {
    if (!rawMessage) {
      return { thoughts: [], isThinking: false, cleanContent: '', toolCalls: [] };
    }

    // Step 1: Strip control tokens
    const stripped = this.stripControlTokens(rawMessage);

    // Step 2: Extract thoughts
    const { thoughts, isThinking, cleanContent: afterThoughts } = this.extractThoughts(stripped);

    // Step 3: Extract tool calls
    const { toolCalls, cleanContent: afterTools } = this.extractToolCalls(afterThoughts);

    return {
      thoughts,
      isThinking,
      cleanContent: afterTools,
      toolCalls,
    };
  }
}
