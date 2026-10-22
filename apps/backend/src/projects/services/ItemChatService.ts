import { type ChatItem, type Conversation, itemChatIdFor } from '../../engine/index.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';

export interface ItemChatDeps {
  leaves: () => Promise<Leaf[]>;
  branches: () => Promise<Branch[]>;
  trees: () => Promise<Tree[]>;
  conversation: (ownerId: string, id: string) => Promise<Conversation | undefined>;
  save: (conversation: Conversation) => Promise<void>;
  now?: (() => string) | undefined;
}

export class ItemChatService {
  constructor(private readonly deps: ItemChatDeps) {}

  async ensure(ownerId: string, item: ChatItem): Promise<Conversation | undefined> {
    const leaf = item.kind === 'story' ? (await this.deps.leaves()).find((candidate) => candidate.id === item.leafId && candidate.ownerId === ownerId) : undefined;
    if (item.kind === 'story' && !leaf) return undefined;
    const branchId = leaf?.branchId ?? (item.kind === 'feature' ? item.branchId : undefined);
    const branch = (await this.deps.branches()).find((candidate) => candidate.id === branchId && candidate.ownerId === ownerId);
    if (!branch) return undefined;
    const tree = (await this.deps.trees()).find((candidate) => candidate.id === branch.treeId && candidate.ownerId === ownerId);
    if (!tree) return undefined;
    const id = itemChatIdFor(item);
    const found = await this.deps.conversation(ownerId, id);
    if (found) return found;
    const at = (this.deps.now ?? (() => new Date().toISOString()))();
    const chat: Conversation = {
      id,
      ownerId,
      title: leaf ? leaf.title : branch.title,
      kind: 'item',
      treeId: tree.id,
      ...(leaf ? { leafId: leaf.id } : { branchId: branch.id }),
      messages: [],
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.save(chat);
    return chat;
  }
}
