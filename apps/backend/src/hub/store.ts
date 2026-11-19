import type { Collection, Db } from 'mongodb';
import { fromDoc, Records, type AreaStore } from '../platform/lib/collection.js';
import { watchWrites, type Watching } from '../platform/lib/change-streams.js';
import { leaseMongo, type MongoLease } from '../platform/lib/mongo-lease.js';
import { fieldUpdate, messageUpdates, type HubChange, type HubDirty, type HubLink, type HubSyncStore, type RecordPatch, type SyncedDoc, type SyncedKind } from './lib/hub-sync.js';
import { projectDatabase, type HubInvite, type HubMember, type SharedProject } from './lib/hub.js';
import type { HubStore as HubRegistryStore, SharedProjectStore } from './lib/hub-store.js';
import type { HubRequest, HubStatus } from './lib/hub-board.js';

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

  watchHubDirty(on: () => void): Watching {
    return watchWrites(() => this.dirty.raw, {}, () => on());
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

const without = <T>(doc: Record<string, unknown> | null, key: string, as: string): T | undefined => {
  if (!doc) return undefined;
  const { _id, ...rest } = doc;
  return { ...rest, [as]: String(_id) } as T;
};

export function mongoHubStore(uri: string, registry: string): HubRegistryStore {
  let lease: MongoLease | undefined;
  let db: Db | undefined;
  const reg = () => {
    if (!db) throw new Error('the hub store is not open');
    return db;
  };

  const project = (id: string): SharedProjectStore => {
    const own = () => {
      if (!lease) throw new Error('the hub store is not open');
      return lease.client.db(projectDatabase(id));
    };
    return {
      async members() {
        return (await own().collection('members').find({}).toArray()).map((doc) => without<HubMember>(doc, '_id', 'personId')!);
      },
      async saveMember(member) {
        const { personId, ...rest } = member;
        await own().collection('members').replaceOne({ _id: personId as never }, rest, { upsert: true });
      },
      async deleteMember(personId) { await own().collection('members').deleteOne({ _id: personId as never }); },
      async invites() {
        return (await own().collection('invites').find({}).toArray()).map((doc) => without<HubInvite>(doc, '_id', 'token')!);
      },
      async saveInvite(invite) {
        const { token, ...rest } = invite;
        await own().collection('invites').replaceOne({ _id: token as never }, rest, { upsert: true });
      },
      async deleteInvite(token) { await own().collection('invites').deleteOne({ _id: token as never }); },
      async records(kind) {
        return (await own().collection(`board_${kind}`).find({}).toArray()).map((doc) => without<SyncedDoc>(doc, '_id', 'id')!);
      },
      async record(kind, recordId) { return without<SyncedDoc>(await own().collection(`board_${kind}`).findOne({ _id: recordId as never }), '_id', 'id'); },
      async putRecord(kind, doc) {
        const { id: recordId, ...rest } = doc;
        await own().collection(`board_${kind}`).replaceOne({ _id: recordId as never }, rest, { upsert: true });
      },
      async deleteRecord(kind, recordId) { await own().collection(`board_${kind}`).deleteOne({ _id: recordId as never }); },
      async logChange(entry) {
        const counter = await own().collection<{ _id: string; seq: number }>('counters').findOneAndUpdate({ _id: 'changes' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
        const change = { ...entry, seq: counter!.seq } as HubChange;
        await own().collection('changes').insertOne({ _id: change.seq as never, ...change });
        return change;
      },
      async changes(after, limit) {
        return (await own().collection('changes').find({ _id: { $gt: after } as never }).sort({ _id: 1 }).limit(limit).toArray()).map(({ _id, ...rest }) => rest as unknown as HubChange);
      },
      async requests() {
        return (await own().collection('requests').find({}).sort({ at: 1 }).toArray()).map((doc) => without<HubRequest>(doc, '_id', 'id')!);
      },
      async saveRequest(request) {
        const { id: requestId, ...rest } = request;
        await own().collection('requests').replaceOne({ _id: requestId as never }, rest, { upsert: true });
      },
      async status() {
        const doc = await own().collection('status').findOne({ _id: 'status' as never });
        if (!doc) return undefined;
        const { _id, ...rest } = doc;
        return rest as unknown as HubStatus;
      },
      async putStatus(status) { await own().collection('status').replaceOne({ _id: 'status' as never }, status, { upsert: true }); },
      async drop() { await own().dropDatabase(); },
    };
  };

  return {
    async init() {
      lease = await leaseMongo(uri);
      db = lease.client.db(registry);
      await db.collection('shared_memberships').createIndex({ personId: 1, projectId: 1 }, { unique: true });
    },
    async close() {
      const held = lease;
      lease = undefined;
      db = undefined;
      await held?.release();
    },
    async saveProject(shared) {
      const { id, ...rest } = shared;
      await reg().collection('shared_projects').replaceOne({ _id: id as never }, rest, { upsert: true });
    },
    async getProject(id) { return without<SharedProject>(await reg().collection('shared_projects').findOne({ _id: id as never }), '_id', 'id'); },
    async deleteProject(id) { await reg().collection('shared_projects').deleteOne({ _id: id as never }); },
    async addMembership(personId, projectId) { await reg().collection('shared_memberships').updateOne({ personId, projectId }, { $set: { personId, projectId } }, { upsert: true }); },
    async removeMembership(personId, projectId) { await reg().collection('shared_memberships').deleteOne({ personId, projectId }); },
    async projectsOf(personId) { return (await reg().collection('shared_memberships').find({ personId }).toArray()).map((doc) => String(doc.projectId)).sort(); },
    async indexInvite(token, projectId) { await reg().collection('shared_invites').replaceOne({ _id: token as never }, { projectId }, { upsert: true }); },
    async projectOfInvite(token) { const doc = await reg().collection('shared_invites').findOne({ _id: token as never }); return doc ? String(doc.projectId) : undefined; },
    async forgetInvite(token) { await reg().collection('shared_invites').deleteOne({ _id: token as never }); },
    project,
  };
}
