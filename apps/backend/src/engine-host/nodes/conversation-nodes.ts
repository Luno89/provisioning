import {
  NOT_RUN_CALL,
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
  return asStoredToolCallsMany([reply], results);
}

// The reply alone is the latest round of a multi-round turn, so a turn the model took in at least two
// passes would save without the calls it made in the middle. Runs through every round the
// Conversation node accumulated (plus the latest reply, which that node has not seen yet when the
// turn ends in words) and keeps each call once, in the order the model asked, matched against every
// result. A refusal is a result, so it keeps its reason; a call with no result at all keeps its
// place with NOT_RUN_CALL.
export function asStoredToolCallsMany(
  replies: readonly ModelReply[],
  results: readonly ToolResult[],
): ConversationToolCall[] {
  const seenReplies = new Map<string, ModelReply>();
  for (const reply of replies) {
    if (reply && !seenReplies.has(reply.id)) seenReplies.set(reply.id, reply);
  }

  const seenCalls = new Set<string>();
  const calls: ConversationToolCall[] = [];
  for (const reply of seenReplies.values()) {
    for (const call of reply.toolCalls) {
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      const answer =
        results.find((result) => result.forReply === reply.id && result.callId === call.id)
        ?? results.find((result) => result.callId === call.id);
      calls.push({
        id: call.id,
        name: call.name,
        args: call.arguments,
        ok: answer ? answer.ok : false,
        digest: answer ? answer.content : NOT_RUN_CALL,
      });
    }
  }
  return calls;
}

// The Conversation node hands back one record per model round it has seen: the reply and the
// results its calls drew back. Everything is still a plain value at this point, so check it.
function readRoundRecords(request: NodeRequest): { reply: ModelReply; results: ToolResult[] }[] {
  const raw = request.inputs.rounds;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((entry): entry is { reply: ModelReply; results: ToolResult[] } =>
      Boolean(entry)
      && typeof entry === 'object'
      && Array.isArray((entry as { results?: unknown }).results))
    .map((entry) => ({
      reply: (entry as { reply: ModelReply }).reply,
      results: (entry as { results: ToolResult[] }).results.filter(
        (result) => Boolean(result) && typeof result === 'object',
      ),
    }))
    .filter((round) => round.reply && Array.isArray(round.reply.toolCalls));
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
      const rounds = readRoundRecords(request);
      const now = new Date().toISOString();

      const existing = await store.get(ownerId, id);

      // The host may retry this very step after a crash — written, but the result never recorded.
      // The earlier attempt already left this exchange as the last messages, so a plain append
      // would show the turn twice. Its ask and answer are exactly what got written, so detect
      // that and report it as saved rather than appending again.
      const written = existing?.messages ?? [];
      const last = written[written.length - 1];
      const beforeLast = written[written.length - 2];
      if (
        last?.role === 'assistant' && last.content === reply.content
        && (asked.trim() ? beforeLast?.role === 'user' && beforeLast.content === asked : true)
      ) {
        return { exit: 'saved', outputs: { conversation: id } };
      }

      const toolCalls = rounds.length
        ? asStoredToolCallsMany([...rounds.map((round) => round.reply), reply], [...rounds.flatMap((round) => round.results), ...results])
        : asStoredToolCalls(reply, results);

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

      const nodeTitle = String(request.node.settings.title ?? '').trim();

      await store.save({
        ...(existing ?? {
          id,
          ownerId,
          title: nodeTitle || titleFrom(asked),
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
