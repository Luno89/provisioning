import type { Database } from '../../platform/index.js';
import { chatFolder } from '../lib/file-places.js';

export interface ChatBinding {
  treeId: string;
  projectId?: string | undefined;
}

export type BindChat = (ownerId: string, conversationId: string, binding: ChatBinding) => Promise<boolean>;

export function bindChatWithItsFiles(db: Pick<Database, 'transaction' | 'engine' | 'files'>, now: () => string = () => new Date().toISOString()): BindChat {
  return (ownerId, conversationId, binding) => db.transaction(async (tx) => {
    const bound = await db.engine.bindConversation(ownerId, conversationId, binding, tx);
    if (bound && binding.projectId) {
      await db.files.moveStoredScope(ownerId, { kind: 'conversation', id: conversationId }, { kind: 'project', id: binding.projectId }, chatFolder(conversationId), now(), tx);
    }
    return bound;
  });
}
