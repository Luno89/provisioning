import type { Database } from '../../platform/index.js';
import type { Branch, Leaf } from '../../projects/lib/leaves.js';
import type { Tree } from '../../projects/lib/trees.js';
import type { Conversation, ConversationMessage } from '../../engine/lib/conversations.js';
import type { SyncedDoc, SyncedKind } from '../lib/hub-sync.js';

type Instance = Pick<Database, 'hub' | 'projects' | 'engine'>;

type Kept = { trees: Tree; branches: Branch; leaves: Leaf; conversations: Conversation };

export async function mirrored(db: Pick<Database, 'hub'>, kind: SyncedKind, doc: SyncedDoc): Promise<void> {
  const { id, messages, ...fields } = doc;
  const put = Array.isArray(messages) ? (messages as ConversationMessage[]) : [];
  await db.hub.deleteSyncedRecord(kind, id);
  await db.hub.patchSyncedRecord(kind, id, { set: fields, ...(put.length > 0 ? { messages: { put } } : {}) });
}

export async function saved<K extends keyof Kept>(db: Instance, kind: K, doc: Kept[K]): Promise<void> {
  if (kind === 'trees') await db.projects.saveTree(doc as Tree);
  else if (kind === 'branches') await db.projects.saveBranch(doc as Branch);
  else if (kind === 'leaves') await db.projects.saveLeaf(doc as Leaf);
  else await db.engine.saveConversation(doc as Conversation);
  await mirrored(db, kind, doc as unknown as SyncedDoc);
}

export async function removed(db: Instance, kind: keyof Kept, id: string): Promise<void> {
  if (kind === 'trees') await db.projects.deleteTree(id);
  else if (kind === 'branches') await db.projects.deleteBranch(id);
  else if (kind === 'leaves') await db.projects.deleteLeaf(id);
  else await db.engine.deleteConversation(id);
  await db.hub.deleteSyncedRecord(kind, id);
}
