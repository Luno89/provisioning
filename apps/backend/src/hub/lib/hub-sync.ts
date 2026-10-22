import type { ConversationMessage } from '../../engine/lib/conversations.js';

export const SYNCED_KINDS = ['trees', 'branches', 'leaves', 'tasks', 'conversations', 'planProposals'] as const;
export type SyncedKind = typeof SYNCED_KINDS[number];
export const isSyncedKind = (value: unknown): value is SyncedKind => SYNCED_KINDS.includes(value as SyncedKind);

export type SyncedDoc = Record<string, unknown> & { id: string };

export interface RecordPatch {
  set?: Record<string, unknown>;
  unset?: string[];
  messages?: { put?: ConversationMessage[]; drop?: string[] };
}

export type RecordChange =
  | { kind: SyncedKind; id: string; patch: RecordPatch }
  | { kind: SyncedKind; id: string; deleted: true };

export interface HubChange {
  seq: number;
  origin: string;
  change: RecordChange;
  at: string;
}

const KEPT_APART = new Set(['id', 'messages']);

export const messageKey = (message: Pick<ConversationMessage, 'role' | 'at' | 'author'>): string => {
  const author = message.author;
  const who = !author ? '' : author.kind === 'person' ? `person:${author.id}` : author.kind === 'agent' ? `agent:${author.slug}` : 'platform';
  return `${message.role}|${message.at}|${who}`;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function diffRecord(before: SyncedDoc | undefined, after: SyncedDoc): RecordPatch | undefined {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [field, value] of Object.entries(after)) {
    if (KEPT_APART.has(field) || value === undefined) continue;
    if (!before || !same(before[field], value)) set[field] = value;
  }
  for (const field of Object.keys(before ?? {})) {
    if (KEPT_APART.has(field) || before![field] === undefined) continue;
    if (after[field] === undefined) unset.push(field);
  }
  const was = new Map(((before?.messages ?? []) as ConversationMessage[]).map((message) => [messageKey(message), message]));
  const now = new Map(((after.messages ?? []) as ConversationMessage[]).map((message) => [messageKey(message), message]));
  const put = [...now.entries()].filter(([key, message]) => !same(was.get(key), message)).map(([, message]) => message);
  const drop = [...was.keys()].filter((key) => !now.has(key));
  const patch: RecordPatch = {
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
    ...(put.length > 0 || drop.length > 0 ? { messages: { ...(put.length > 0 ? { put } : {}), ...(drop.length > 0 ? { drop } : {}) } } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export type MessageMatch = { role: string; at: string; author: Record<string, unknown> | { $exists: false } };

export function messageMatch(key: string): MessageMatch {
  const [role = '', at = '', who = ''] = key.split('|');
  const author = who === '' ? { $exists: false as const }
    : who === 'platform' ? { kind: 'platform' }
      : who.startsWith('person:') ? { kind: 'person', id: who.slice('person:'.length) }
        : { kind: 'agent', slug: who.slice('agent:'.length) };
  return { role, at, author };
}

export interface FieldUpdate {
  $set?: Record<string, unknown>;
  $unset?: Record<string, ''>;
}

export function fieldUpdate(patch: RecordPatch): FieldUpdate | undefined {
  const update: FieldUpdate = {};
  if (patch.set && Object.keys(patch.set).length > 0) update.$set = patch.set;
  if (patch.unset && patch.unset.length > 0) update.$unset = Object.fromEntries(patch.unset.map((field) => [field, '' as const]));
  return update.$set || update.$unset ? update : undefined;
}

export function messageUpdates(patch: RecordPatch): { pull?: MessageMatch[]; push?: ConversationMessage[] } {
  if (!patch.messages) return {};
  const put = patch.messages.put ?? [];
  const keys = [...new Set([...(patch.messages.drop ?? []), ...put.map(messageKey)])];
  return { ...(keys.length ? { pull: keys.map(messageMatch) } : {}), ...(put.length ? { push: put } : {}) };
}

export function applyPatch(doc: SyncedDoc | undefined, id: string, patch: RecordPatch): SyncedDoc {
  const next: SyncedDoc = { ...(doc ?? {}), ...(patch.set ?? {}), id };
  for (const field of patch.unset ?? []) delete next[field];
  if (patch.messages) {
    const byKey = new Map(((doc?.messages ?? []) as ConversationMessage[]).map((message) => [messageKey(message), message]));
    for (const key of patch.messages.drop ?? []) byKey.delete(key);
    for (const message of patch.messages.put ?? []) byKey.set(messageKey(message), message);
    next.messages = [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
  }
  return next;
}

export interface ShareScope {
  treeIds: ReadonlySet<string>;
  branchIds: ReadonlySet<string>;
  leafIds: ReadonlySet<string>;
  conversationIds: ReadonlySet<string>;
  projectId: string;
}

export function inScope(kind: SyncedKind, doc: SyncedDoc, scope: ShareScope): boolean {
  switch (kind) {
    case 'trees': return scope.treeIds.has(doc.id);
    case 'branches': return scope.treeIds.has(String(doc.treeId));
    case 'leaves': return scope.branchIds.has(String(doc.branchId));
    case 'tasks': return scope.leafIds.has(String(doc.leafId)) || (!doc.leafId && doc.projectId === scope.projectId);
    case 'conversations': return (doc.kind === 'channel' || doc.kind === 'item') && (scope.treeIds.has(String(doc.treeId)) || doc.projectId === scope.projectId);
    case 'planProposals': return scope.conversationIds.has(String(doc.conversationId));
  }
}

export function scopeOf(projectId: string, world: { trees: SyncedDoc[]; branches: SyncedDoc[]; leaves: SyncedDoc[]; conversations: SyncedDoc[] }): ShareScope {
  const treeIds = new Set(world.trees.filter((tree) => ((tree.projectIds as string[] | undefined) ?? []).includes(projectId)).map((tree) => tree.id));
  const branchIds = new Set(world.branches.filter((branch) => treeIds.has(String(branch.treeId))).map((branch) => branch.id));
  const leafIds = new Set(world.leaves.filter((leaf) => branchIds.has(String(leaf.branchId))).map((leaf) => leaf.id));
  const partial: ShareScope = { projectId, treeIds, branchIds, leafIds, conversationIds: new Set() };
  const conversationIds = new Set(world.conversations.filter((conversation) => inScope('conversations', conversation, partial)).map((conversation) => conversation.id));
  return { ...partial, conversationIds };
}

export interface HubMemberName {
  personId: string;
  email: string;
  role: string;
}

export interface HubLink {
  projectId: string;
  ownerId: string;
  hubProjectId: string;
  pulledThrough: number;
  sharedAt: string;
  group?: string | undefined;
  repo?: { url: string; username: string; tokenEnc: string } | undefined;
  repoHeads?: { owner?: string | undefined; hub?: string | undefined } | undefined;
  repoConflict?: { owner?: string | undefined; hub?: string | undefined; kept: string } | undefined;
  members?: HubMemberName[] | undefined;
}

export interface HubDirty {
  kind: SyncedKind;
  id: string;
  deleted: boolean;
  at: string;
}

export interface HubSyncStore {
  getHubLinks(): Promise<HubLink[]>;
  saveHubLink(link: HubLink): Promise<void>;
  deleteHubLink(projectId: string): Promise<void>;
  markForHub(kind: SyncedKind, id: string, deleted: boolean): Promise<void>;
  hubDirty(limit: number): Promise<HubDirty[]>;
  clearHubDirty(entries: readonly HubDirty[]): Promise<void>;
  syncedRecord(kind: SyncedKind, id: string): Promise<SyncedDoc | undefined>;
  patchSyncedRecord(kind: SyncedKind, id: string, patch: RecordPatch): Promise<void>;
  deleteSyncedRecord(kind: SyncedKind, id: string): Promise<void>;
  hubSnapshot(kind: SyncedKind, id: string): Promise<{ projectId: string; doc: SyncedDoc } | undefined>;
  saveHubSnapshot(projectId: string, kind: SyncedKind, doc: SyncedDoc): Promise<void>;
  deleteHubSnapshot(kind: SyncedKind, id: string): Promise<void>;
  deleteHubSnapshots(projectId: string): Promise<void>;
}

type WriteOf = { kind: SyncedKind; id: (args: unknown[]) => unknown; deleted?: true };

const first = (args: unknown[]) => (args[0] as { id?: unknown } | undefined)?.id;
const second = (args: unknown[]) => args[1];

export const HUB_WRITES: Readonly<Record<string, WriteOf>> = {
  saveTree: { kind: 'trees', id: first },
  deleteTree: { kind: 'trees', id: (args) => args[0], deleted: true },
  saveBranch: { kind: 'branches', id: first },
  deleteBranch: { kind: 'branches', id: (args) => args[0], deleted: true },
  saveLeaf: { kind: 'leaves', id: first },
  deleteLeaf: { kind: 'leaves', id: (args) => args[0], deleted: true },
  saveTask: { kind: 'tasks', id: first },
  deleteTask: { kind: 'tasks', id: (args) => args[0], deleted: true },
  saveConversation: { kind: 'conversations', id: first },
  deleteConversation: { kind: 'conversations', id: (args) => args[0], deleted: true },
  appendMessage: { kind: 'conversations', id: second },
  appendNotice: { kind: 'conversations', id: second },
  allowToolInConversation: { kind: 'conversations', id: second },
  setConversationAutoMode: { kind: 'conversations', id: second },
  bindConversation: { kind: 'conversations', id: second },
  savePlanProposal: { kind: 'planProposals', id: first },
  deletePlanProposal: { kind: 'planProposals', id: second, deleted: true },
};

export function markingHubWrites<T extends object>(db: T, hub: Pick<HubSyncStore, 'markForHub'>): T {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      const write = typeof property === 'string' ? HUB_WRITES[property] : undefined;
      if (!write || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result = await (value as (...given: unknown[]) => unknown).apply(receiver, args);
        const id = write.id(args);
        if (typeof id === 'string' && id) await hub.markForHub(write.kind, id, write.deleted === true);
        return result;
      };
    },
  });
}
