import {
  valueImplementation,
  stepImplementation,
  fillTemplate,
  type ChatMessage,
  type ModelReply,
  type NodeImplementation,
  type NodeRequest,
  type ToolResult,
} from '@koala/agent-engine/procedure';
import { titleFrom } from '../../lib/conversations.js';
import { historyForPrompt } from '../../lib/koala-context.js';
import type { Conversation, ConversationMessage, ConversationToolCall } from '../../lib/conversations.js';

export interface ConversationStore {
  get(ownerId: string, id: string): Promise<Conversation | undefined>;
  save(conversation: Conversation): Promise<void>;
}

export function inMemoryConversations(): ConversationStore {
  const rows: Conversation[] = [];

  return {
    get: async (ownerId, id) => rows.find((one) => one.id === id && one.ownerId === ownerId),
    save: async (conversation) => {
      const at = rows.findIndex((one) => one.id === conversation.id && one.ownerId === conversation.ownerId);
      if (at === -1) rows.push(conversation); else rows[at] = conversation;
    },
  };
}

export const idFrom = (request: NodeRequest): string => {
  const written = { id: String(request.node.settings.id ?? '') };

  try {
    const filled = fillTemplate(written, {
      values: (request.inputs.values as Record<string, unknown> | undefined) ?? {},
      text: '',
    }, request.node.id);

    return String(filled.id ?? '').trim() || request.run.identity.runId;
  } catch {
    return request.run.identity.runId;
  }
};

export function asChatMessages(stored: readonly ConversationMessage[]): ChatMessage[] {
  return historyForPrompt([...stored])
    .filter((message: ConversationMessage) => message.content.trim())
    .map((message: ConversationMessage) => ({ role: message.role, content: message.content }));
}

export function asStoredToolCalls(
  reply: ModelReply,
  results: readonly ToolResult[],
): ConversationToolCall[] {
  return reply.toolCalls.map((call) => {
    const answer = results.find((result) => result.callId === call.id);
    return {
      id: call.id,
      name: call.name,
      args: call.arguments,
      ok: answer?.ok ?? false,
      digest: answer?.content ?? '',
    };
  });
}

export function createConversationNodes(store: ConversationStore): NodeImplementation[] {
  return [
    valueImplementation('load-conversation', async (request) => {
      const id = idFrom(request);
      const found = id ? await store.get(request.run.launch.ownerId, id) : undefined;

      return { outputs: { messages: asChatMessages(found?.messages ?? []), found: Boolean(found) } };
    }),

    stepImplementation('save-conversation', async (request) => {
      const id = idFrom(request);
      const reply = request.inputs.reply as ModelReply | undefined;
      if (!reply) return { exit: 'failed', outputs: { conversation: id } };

      const asked = String(request.inputs.asked ?? '');
      const ownerId = request.run.launch.ownerId;
      const results = ((request.inputs.results as ToolResult[][] | undefined) ?? []).flat();
      const now = new Date().toISOString();

      const existing = await store.get(ownerId, id);
      const toolCalls = asStoredToolCalls(reply, results);

      const turns: ConversationMessage[] = [
        ...(asked.trim() ? [{ role: 'user' as const, content: asked, at: now }] : []),
        {
          role: 'assistant' as const,
          content: reply.content,
          at: now,
          ...(reply.thinking.trim() ? { reasoning: reply.thinking } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
        },
      ];

      const written = String(request.node.settings.title ?? '').trim();

      await store.save({
        ...(existing ?? {
          id,
          ownerId,
          title: written || titleFrom(asked),
          messages: [],
          createdAt: now,
        }),
        id,
        ownerId,
        messages: [...(existing?.messages ?? []), ...turns],
        updatedAt: now,
      } as Conversation);

      return { exit: 'saved', outputs: { conversation: id } };
    }),
  ];
}
