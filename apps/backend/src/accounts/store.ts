import { ACCOUNT_DATA, type AccountIds, type AccountRelated } from './lib/account-removal.js';
import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db } from 'mongodb';
import type { InviteMetadata, UserMetadata } from '../platform/index.js';

export interface AccountsStore extends AreaStore {
  getUsers(): Promise<UserMetadata[]>;
  accountIds(ownerId: string): Promise<AccountIds>;
  removeAccountRecords(ownerId: string, related: AccountRelated): Promise<Record<string, number>>;
  accountLeftovers(ownerId: string): Promise<Record<string, number>>;
  saveUser(user: UserMetadata): Promise<void>;
  saveUserList(users: UserMetadata[]): Promise<void>;
  getUserByEmail(email: string): Promise<UserMetadata | undefined>;
  getUserById(id: string): Promise<UserMetadata | undefined>;
  deleteUser(id: string): Promise<void>;
  getInvites(): Promise<InviteMetadata[]>;
  saveInvite(invite: InviteMetadata): Promise<void>;
}

export class MongoAccountsStore implements AccountsStore {
  constructor(private readonly db: () => Db) {}

  private get conversations(): Collection {
    return this.db().collection('conversations');
  }

  private get corpus(): Collection {
    return this.db().collection('corpus');
  }

  private get invites(): Collection {
    return this.db().collection('invites');
  }

  private get pipelineRuns(): Collection {
    return this.db().collection('pipelineRuns');
  }

  private get turnLogs(): Collection {
    return this.db().collection('turnLogs');
  }

  private get users(): Collection {
    return this.db().collection('users');
  }

  async ensureIndexes(): Promise<void> {
    await this.users.createIndex({ email: 1 }, { unique: true });
  }

  async getInvites(): Promise<InviteMetadata[]> {
    return (await this.invites.find({}).toArray()).map(doc => fromDoc<InviteMetadata>(doc));
  }

  async saveInvite(invite: InviteMetadata): Promise<void> {
    const doc = toDoc(invite);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.invites.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async accountIds(ownerId: string): Promise<AccountIds> {
    const ids = async (name: string, field = '_id') =>
      (await this.db().collection(name).find({ ownerId }, { projection: { [field]: 1 } }).toArray()).map((doc) => String(doc[field]));
    const conversations = await this.conversations.find({ ownerId }, { projection: { _id: 1, liveTurn: 1 } }).toArray();
    const turns = (await this.turnLogs.distinct('turnId', { ownerId })) as string[];
    const live = conversations.map((doc) => (doc.liveTurn as { runId?: string } | undefined)?.runId).filter((id): id is string => typeof id === 'string');
    const projectIds = await ids('projects');
    return {
      runIds: [...new Set([...turns, ...live])],
      treeIds: await ids('trees'),
      conversationIds: conversations.map((doc) => String(doc._id)),
      proposalIds: await ids('planProposals'),
      projectIds,
      buildWorkflowIds: (await this.pipelineRuns.find({ projectId: { $in: projectIds }, status: { $in: ['queued', 'running'] } }, { projection: { temporalWorkflowId: 1 } }).toArray())
        .map((doc) => doc.temporalWorkflowId).filter((id): id is string => typeof id === 'string'),
      ingestIds: ((await this.corpus.distinct('ingestId', { ownerId })) as unknown[]).filter((id): id is string => typeof id === 'string'),
    };
  }

  async accountLeftovers(ownerId: string): Promise<Record<string, number>> {
    const left: Record<string, number> = {};
    const count = async (name: string, filter: Record<string, unknown>) => {
      const found = await this.db().collection(name).countDocuments(filter as never);
      if (found) left[name] = (left[name] ?? 0) + found;
    };
    for (const name of ACCOUNT_DATA.byOwner) await count(name, { ownerId });
    for (const name of [...ACCOUNT_DATA.byId, ACCOUNT_DATA.last]) await count(name, { _id: ownerId });
    return left;
  }

  async removeAccountRecords(ownerId: string, related: AccountRelated): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    const count = async (name: string, filter: Record<string, unknown>) => {
      const { deletedCount } = await this.db().collection(name).deleteMany(filter as never);
      if (deletedCount) removed[name] = (removed[name] ?? 0) + deletedCount;
    };
    if (related.watermarkKeys.length) await count('memoryWatermarks', { _id: { $in: [...related.watermarkKeys] } });
    if (related.ingestIds.length) await count('crawl_frontier', { ingestId: { $in: [...related.ingestIds] } });
    if (related.projectIds.length) await count('pipelineRuns', { projectId: { $in: [...related.projectIds] } });
    if (related.projectIds.length) await count('hubSnapshots', { projectId: { $in: [...related.projectIds] } });
    for (const name of ACCOUNT_DATA.byOwner) await count(name, { ownerId });
    for (const name of ACCOUNT_DATA.byId) await count(name, { _id: ownerId });
    await count(ACCOUNT_DATA.last, { _id: ownerId });
    return removed;
  }

  async getUsers(): Promise<UserMetadata[]> {
    return (await this.users.find({}).toArray()).map(doc => fromDoc<UserMetadata>(doc));
  }

  async saveUser(user: UserMetadata): Promise<void> {
    const doc = toDoc(user);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.users.replaceOne({ _id: id }, filter, { upsert: true });
  }

  async saveUserList(users: UserMetadata[]): Promise<void> {
    await this.users.deleteMany({});
    if (users.length > 0) {
      await this.users.insertMany(users.map(toDoc));
    }
  }

  async getUserByEmail(email: string): Promise<UserMetadata | undefined> {
    const doc = await this.users.findOne({ email: email.trim().toLowerCase() });
    return doc ? fromDoc<UserMetadata>(doc) : undefined;
  }

  async getUserById(id: string): Promise<UserMetadata | undefined> {
    const doc = await this.users.findOne({ _id: id as any });
    return doc ? fromDoc<UserMetadata>(doc) : undefined;
  }

  async deleteUser(id: string): Promise<void> {
    await this.users.deleteOne({ _id: id as any });
  }
}
