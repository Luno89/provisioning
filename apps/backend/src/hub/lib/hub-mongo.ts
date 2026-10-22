import { MongoClient, type Db } from 'mongodb';
import { projectDatabase, type HubInvite, type HubMember, type SharedProject } from './hub.js';
import type { HubStore, SharedProjectStore } from './hub-store.js';
import type { HubChange, SyncedDoc } from './hub-sync.js';
import type { HubRequest, HubStatus } from './hub-board.js';

const without = <T>(doc: Record<string, unknown> | null, key: string, as: string): T | undefined => {
  if (!doc) return undefined;
  const { _id, ...rest } = doc;
  return { ...rest, [as]: String(_id) } as T;
};

export function mongoHubStore(uri: string, registry: string): HubStore {
  const client = new MongoClient(uri);
  let db: Db | undefined;
  const reg = () => {
    if (!db) throw new Error('the hub store is not open');
    return db;
  };

  const project = (id: string): SharedProjectStore => {
    const own = () => client.db(projectDatabase(id));
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
      await client.connect();
      db = client.db(registry);
      await db.collection('shared_memberships').createIndex({ personId: 1, projectId: 1 }, { unique: true });
    },
    async close() { await client.close(); },
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
