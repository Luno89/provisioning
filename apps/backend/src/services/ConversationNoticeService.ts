import type { ChatItem, Conversation, ConversationNotice } from '../lib/conversations.js';
import { noticeMessage } from '../lib/conversations.js';

export interface ConversationNoticeDeps {
  conversations: () => Promise<Conversation[]>;
  append: (ownerId: string, conversationId: string, message: ReturnType<typeof noticeMessage>) => Promise<boolean>;
  told: (ownerId: string, conversationId: string) => void;
  channelOf?: ((ownerId: string, projectId: string) => Promise<string | undefined>) | undefined;
  itemChatOf?: ((ownerId: string, item: ChatItem) => Promise<string | undefined>) | undefined;
  now?: (() => string) | undefined;
}

export class ConversationNoticeService {
  constructor(private readonly deps: ConversationNoticeDeps) {}

  async post(ownerId: string, scope: { treeId?: string | undefined; projectId?: string | undefined }, notice: ConversationNotice): Promise<string[]> {
    if (!scope.treeId && !scope.projectId) return [];
    const itemChat = notice.refs.leafId ? await this.deps.itemChatOf?.(ownerId, { kind: 'story', leafId: notice.refs.leafId }) : undefined;
    const posted = itemChat ? await this.deliver(ownerId, [itemChat], notice) : [];
    const told = itemChat ? { key: `${notice.key}:line`, kind: notice.kind, text: notice.line ?? notice.text, refs: notice.refs, actions: ['open-story' as const] } : notice;
    return [...posted, ...await this.deliver(ownerId, await this.audience(ownerId, scope), told)];
  }

  private async audience(ownerId: string, scope: { treeId?: string | undefined; projectId?: string | undefined }): Promise<string[]> {
    const channel = scope.projectId ? await this.deps.channelOf?.(ownerId, scope.projectId) : undefined;
    if (channel) return [channel];
    return (await this.deps.conversations()).filter((conversation) => conversation.ownerId === ownerId && conversation.kind !== 'item'
      && ((scope.treeId && conversation.treeId === scope.treeId) || (scope.projectId && conversation.projectId === scope.projectId)))
      .map((conversation) => conversation.id);
  }

  private async deliver(ownerId: string, conversationIds: readonly string[], notice: ConversationNotice): Promise<string[]> {
    const at = (this.deps.now ?? (() => new Date().toISOString()))();
    const posted: string[] = [];
    for (const id of conversationIds) {
      if (await this.deps.append(ownerId, id, noticeMessage(notice, at))) {
        posted.push(id);
        this.deps.told(ownerId, id);
      }
    }
    return posted;
  }
}
