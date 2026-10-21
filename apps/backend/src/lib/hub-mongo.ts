import { MongoClient, type Db } from 'mongodb';
import { projectDatabase, type HubInvite, type HubMember, type SharedProject } from './hub.js';
import type { HubStore, SharedProjectStore } from './hub-store.js';

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
