import type { Collection, Db } from 'mongodb';
import { fromDoc, Records, type AreaStore } from '../platform/lib/collection.js';
import { fieldUpdate, messageUpdates, type HubDirty, type HubLink, type HubSyncStore, type RecordPatch, type SyncedDoc, type SyncedKind } from './lib/hub-sync.js';

export interface HubStore extends HubSyncStore, AreaStore {}

const SYNCED_COLLECTIONS: Readonly<Record<SyncedKind, string>> = {
  trees: 'trees',
  branches: 'branches',
  leaves: 'leaves',
  tasks: 'tasks',
  conversations: 'conversations',
  planProposals: 'planProposals',
};

export class MongoHubStore implements HubStore {
  private readonly links: Records<HubLink & { id: string }>;
  private readonly dirty: Records<HubDirty & { id: string }>;
  private readonly snapshots: Records<{ id: string; projectId: string; kind: SyncedKind; doc: SyncedDoc }>;

  constructor(private readonly db: () => Db) {
    this.links = new Records(db, 'hubLinks');
    this.dirty = new Records(db, 'hubDirty');
    this.snapshots = new Records(db, 'hubSnapshots');
  }

  private synced(kind: SyncedKind): Collection {
    return this.db().collection(SYNCED_COLLECTIONS[kind]);
  }

  async ensureIndexes(): Promise<void> {
    await this.dirty.indexes([{ key: { at: 1 } }]);
  }

  async getHubLinks(): Promise<HubLink[]> {
    return (await this.links.raw.find({}).toArray()).map(({ _id, ...rest }) => ({ ...rest, projectId: String(_id) }) as HubLink);
  }

  async saveHubLink(link: HubLink): Promise<void> {
    const { projectId, ...rest } = link;
    await this.links.raw.replaceOne({ _id: projectId as never }, rest, { upsert: true });
  }

  async deleteHubLink(projectId: string): Promise<void> {
    await this.links.remove(projectId);
  }

  async markForHub(kind: SyncedKind, id: string, deleted: boolean): Promise<void> {
    if (await this.links.raw.estimatedDocumentCount() === 0) return;
    const at = `${String(Date.now()).padStart(15, '0')}-${Math.random().toString(36).slice(2, 10)}`;
    await this.dirty.raw.replaceOne({ _id: `${kind}/${id}` as never }, { kind, id, deleted, at }, { upsert: true });
  }

  async hubDirty(limit: number): Promise<HubDirty[]> {
    return (await this.dirty.raw.find({}).sort({ at: 1 }).limit(limit).toArray()).map(({ _id, ...rest }) => rest as unknown as HubDirty);
  }

  async clearHubDirty(entries: readonly HubDirty[]): Promise<void> {
    for (const entry of entries) await this.dirty.raw.deleteOne({ _id: `${entry.kind}/${entry.id}` as never, at: entry.at });
  }

  async syncedRecord(kind: SyncedKind, id: string): Promise<SyncedDoc | undefined> {
    const doc = await this.synced(kind).findOne({ _id: id as never });
    return doc ? fromDoc<SyncedDoc>(doc) : undefined;
  }

  async patchSyncedRecord(kind: SyncedKind, id: string, patch: RecordPatch): Promise<void> {
    const collection = this.synced(kind);
    const fields = fieldUpdate(patch);
    const messages = messageUpdates(patch);
    if (fields) await collection.updateOne({ _id: id as never }, fields, { upsert: true });
    if (messages.pull) await collection.updateOne({ _id: id as never }, { $pull: { messages: { $or: messages.pull } } } as never);
    if (messages.push) await collection.updateOne({ _id: id as never }, { $push: { messages: { $each: messages.push, $sort: { at: 1 } } } } as never, { upsert: true });
  }

  async deleteSyncedRecord(kind: SyncedKind, id: string): Promise<void> {
    await this.synced(kind).deleteOne({ _id: id as never });
  }

  async hubSnapshot(kind: SyncedKind, id: string): Promise<{ projectId: string; doc: SyncedDoc } | undefined> {
    const found = await this.snapshots.raw.findOne({ _id: `${kind}/${id}` as never });
    return found ? { projectId: String(found.projectId), doc: found.doc as SyncedDoc } : undefined;
  }

  async saveHubSnapshot(projectId: string, kind: SyncedKind, doc: SyncedDoc): Promise<void> {
    await this.snapshots.raw.replaceOne({ _id: `${kind}/${doc.id}` as never }, { projectId, kind, doc }, { upsert: true });
  }

  async deleteHubSnapshot(kind: SyncedKind, id: string): Promise<void> {
    await this.snapshots.remove(`${kind}/${id}`);
  }

  async deleteHubSnapshots(projectId: string): Promise<void> {
    await this.snapshots.removeWhere({ projectId });
  }
}
