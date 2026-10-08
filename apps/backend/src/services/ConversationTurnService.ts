import { closeTurn, openTurn, type Conversation } from '../lib/conversations.js';
import { replyFromLog, type TurnLogEntry } from '../lib/turn-log.js';

export const ENDED_UNSAVED = 'the run ended before it saved its reply';

export class ConversationTurnService {
  constructor(private readonly deps: {
    store: {
      getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
      saveConversation(conversation: Conversation): Promise<void>;
    };
    log: { getTurnLog(ownerId: string, turnId: string, after: number): Promise<TurnLogEntry[]> };
    running: (runId: string) => Promise<boolean>;
    now?: (() => string) | undefined;
  }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async open(turn: { ownerId: string; conversationId: string; runId: string; message: string }): Promise<void> {
    const existing = await this.deps.store.getConversation(turn.ownerId, turn.conversationId);
    await this.deps.store.saveConversation(openTurn(existing, { ...turn, now: this.now() }));
  }

  async fail(turn: { ownerId: string; conversationId: string; runId: string }, why: string): Promise<void> {
    const conversation = await this.deps.store.getConversation(turn.ownerId, turn.conversationId);
    if (!conversation) return;
    const now = this.now();
    await this.deps.store.saveConversation(closeTurn(conversation, turn.runId, { content: '', at: now, interruptedReason: why }, now));
  }

  async settle(conversation: Conversation): Promise<Conversation> {
    const live = conversation.liveTurn;
    if (!live || await this.deps.running(live.runId).catch(() => true)) return conversation;
    const reply = replyFromLog(await this.deps.log.getTurnLog(conversation.ownerId, live.runId, 0), live.runId);
    const now = this.now();
    const settled = closeTurn(conversation, live.runId, {
      content: reply.content,
      at: now,
      ...(reply.reasoning.trim() ? { reasoning: reply.reasoning } : {}),
      ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}),
      interruptedReason: ENDED_UNSAVED,
    }, now);
    await this.deps.store.saveConversation(settled);
    return settled;
  }
}
