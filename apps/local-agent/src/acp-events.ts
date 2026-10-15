import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

export const TOOL_OUTPUT_CHARS = 4000;

export interface ToolState {
  callId: string;
  title: string;
  kind: ToolKind | 'other';
  status: ToolCallStatus;
  input?: unknown;
  output?: string | undefined;
  paths?: string[] | undefined;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; tool: ToolState }
  | { type: 'plan'; entries: { content: string; status: string }[] }
  | { type: 'mode'; modeId: string };

export const blockText = (block: ContentBlock): string => {
  switch (block.type) {
    case 'text': return block.text;
    case 'resource_link': return block.uri;
    case 'resource': return 'text' in block.resource ? block.resource.text : block.resource.uri;
    default: return '';
  }
};

const contentText = (content: ToolCallContent): string => {
  switch (content.type) {
    case 'content': return blockText(content.content);
    case 'diff': return `edited ${content.path}`;
    case 'terminal': return `terminal ${content.terminalId}`;
  }
};

const cut = (text: string): string => (text.length > TOOL_OUTPUT_CHARS ? `${text.slice(0, TOOL_OUTPUT_CHARS)}…` : text);

const outputOf = (content: ToolCallContent[] | null | undefined, raw: unknown): string | undefined => {
  const text = (content ?? []).map(contentText).filter(Boolean).join('\n');
  if (text) return cut(text);
  if (raw === undefined || raw === null) return undefined;
  return cut(typeof raw === 'string' ? raw : JSON.stringify(raw));
};

export class AgentEvents {
  private readonly tools = new Map<string, ToolState>();

  read(update: SessionUpdate): AgentEvent | undefined {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const delta = blockText(update.content);
        return delta ? { type: 'text', delta } : undefined;
      }
      case 'agent_thought_chunk': {
        const delta = blockText(update.content);
        return delta ? { type: 'thinking', delta } : undefined;
      }
      case 'tool_call': {
        const output = outputOf(update.content, update.rawOutput);
        const paths = update.locations?.map((location) => location.path);
        const tool: ToolState = {
          callId: update.toolCallId,
          title: update.title,
          kind: update.kind ?? 'other',
          status: update.status ?? 'pending',
          ...(update.rawInput === undefined ? {} : { input: update.rawInput }),
          ...(output === undefined ? {} : { output }),
          ...(paths?.length ? { paths } : {}),
        };
        this.tools.set(tool.callId, tool);
        return { type: 'tool', tool };
      }
      case 'tool_call_update': {
        const was = this.tools.get(update.toolCallId) ?? { callId: update.toolCallId, title: update.toolCallId, kind: 'other' as const, status: 'pending' as const };
        const output = outputOf(update.content, update.rawOutput);
        const paths = update.locations?.map((location) => location.path);
        const tool: ToolState = {
          ...was,
          ...(update.title ? { title: update.title } : {}),
          ...(update.kind ? { kind: update.kind } : {}),
          ...(update.status ? { status: update.status } : {}),
          ...(update.rawInput === undefined || update.rawInput === null ? {} : { input: update.rawInput }),
          ...(output === undefined ? {} : { output }),
          ...(paths?.length ? { paths } : {}),
        };
        this.tools.set(tool.callId, tool);
        return { type: 'tool', tool };
      }
      case 'plan':
        return { type: 'plan', entries: update.entries.map((entry) => ({ content: entry.content, status: entry.status })) };
      case 'current_mode_update':
        return { type: 'mode', modeId: update.currentModeId };
      default:
        return undefined;
    }
  }

  tool(callId: string): ToolState | undefined {
    return this.tools.get(callId);
  }
}
