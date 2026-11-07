import type { Tx } from '../platform/index.js';
import { ignore } from '@koala/engine-core/failures';
import { randomUUID } from 'node:crypto';
import { type AreaStore, fromDoc } from '../platform/lib/collection.js';
import { decryptValue, encryptValue, type SecretKey } from '../platform/lib/crypto.js';
import type { ClientSession, Collection, Db } from 'mongodb';
import { shareTokenHash, type FileShare } from './lib/file-shares.js';
import type { OldArtifact } from './lib/files-archive.js';
import { commitPlan, folderPlan, movePlan, scopeMovePlan, type CommitPlan, type StoredFileCommit, type StoredFileRecord, type StoredScope } from './lib/stored-files.js';

export type StoredFolderOutcome = { ok: true; made: boolean } | { ok: false; status: 400 | 409; why: string };
export type StoredMoveOutcome = { ok: true; moved: number } | { ok: false; status: 400 | 404 | 409; why: string };

export interface FilesStore extends AreaStore {
  getFileShares(ownerId: string): Promise<FileShare[]>;
  getFileShare(id: string): Promise<FileShare | undefined>;
  getFileShareByToken(token: string): Promise<FileShare | undefined>;
  saveFileShare(share: FileShare): Promise<void>;
  deleteFileShare(id: string): Promise<void>;
  sealShareTokens(): Promise<number>;
  beginStoredFile(record: StoredFileRecord): Promise<void>;
  touchStoredFile(id: string, at: string): Promise<void>;
  commitStoredFiles(commits: readonly StoredFileCommit[], options: { replace: boolean }, at: string): Promise<CommitPlan>;
  storedFilesIn(ownerId: string, scope: StoredScope): Promise<StoredFileRecord[]>;
  storedFileById(id: string): Promise<StoredFileRecord | undefined>;
  storedFileByObject(objectId: string): Promise<StoredFileRecord | undefined>;
  makeStoredFolder(record: StoredFileRecord): Promise<StoredFolderOutcome>;
  moveStoredFiles(ownerId: string, scope: StoredScope, from: string, to: string, at: string): Promise<StoredMoveOutcome>;
  moveStoredScope(ownerId: string, from: StoredScope, to: StoredScope, under: string, at: string, tx?: Tx): Promise<number>;
  deleteStoredFiles(ids: readonly string[]): Promise<void>;
  deadStoredUploads(touchedBefore: string): Promise<StoredFileRecord[]>;
  expiredStoredFiles(now: string): Promise<StoredFileRecord[]>;
  storedObjectIdsAmong(objectIds: readonly string[]): Promise<string[]>;
  storedFilesOwnedBy(ownerId: string): Promise<StoredFileRecord[]>;
  reownRunFiles(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number>;
  oldArtifacts(): AsyncIterable<OldArtifact>;
  forgetOldArtifacts(): Promise<number>;
}

export class MongoFilesStore implements FilesStore {
  constructor(private readonly db: () => Db, private readonly dataKey: SecretKey) {}

  private get shares(): Collection {
    return this.db().collection('fileShares');
  }

  private shareFrom(doc: Record<string, unknown>): FileShare {
    const { _id, tokenHash: _hash, token, ...rest } = doc;
    return { ...(rest as Omit<FileShare, 'id' | 'token'>), id: String(_id), token: decryptValue(String(token), this.dataKey) };
  }

  async ensureIndexes(): Promise<void> {
    await this.shares.createIndex({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $exists: true } } });
    await this.shares.createIndex({ fileId: 1 });
    await this.stored.createIndex({ ownerId: 1, 'scope.kind': 1, 'scope.id': 1, path: 1 }, { unique: true, partialFilterExpression: { state: 'stored' } });
    await this.stored.createIndex({ objectId: 1 });
    await this.stored.createIndex({ state: 1, touchedAt: 1 });
    await this.stored.createIndex({ expiresAt: 1 }, { partialFilterExpression: { expiresAt: { $exists: true } } });
  }

  async getFileShares(ownerId: string): Promise<FileShare[]> {
    const docs = await this.shares.find({ ownerId, tokenHash: { $exists: true } }).sort({ createdAt: -1 }).toArray();
    return docs.map((doc) => this.shareFrom(doc));
  }

  async getFileShare(id: string): Promise<FileShare | undefined> {
    const doc = await this.shares.findOne({ _id: id as never, tokenHash: { $exists: true } });
    return doc ? this.shareFrom(doc) : undefined;
  }

  async getFileShareByToken(token: string): Promise<FileShare | undefined> {
    const doc = await this.shares.findOne({ tokenHash: shareTokenHash(token) });
    return doc ? this.shareFrom(doc) : undefined;
  }

  async saveFileShare(share: FileShare): Promise<void> {
    const { id, token, ...rest } = share;
    await this.shares.replaceOne({ _id: id as never }, { ...rest, tokenHash: shareTokenHash(token), token: encryptValue(token, this.dataKey) }, { upsert: true });
  }

  async deleteFileShare(id: string): Promise<void> {
    await this.shares.deleteOne({ _id: id as never });
  }

  async sealShareTokens(): Promise<number> {
    const plain = await this.shares.find({ tokenHash: { $exists: false } }).toArray();
    for (const { _id, ...rest } of plain) {
      const token = String(_id);
      await this.shares.insertOne({ _id: randomUUID() as never, ...rest, tokenHash: shareTokenHash(token), token: encryptValue(token, this.dataKey) });
      await this.shares.deleteOne({ _id });
    }
    return plain.length;
  }

  private get stored(): Collection<{ _id: string }> {
    return this.db().collection<{ _id: string }>('storedFiles');
  }

  private inTransaction<T>(work: (session: ClientSession) => Promise<T>, tx?: Tx): Promise<T> {
    if (tx?.session) return work(tx.session);
    return this.db().client.withSession((session) => session.withTransaction(() => work(session)));
  }

  private recordOf(doc: Record<string, unknown>): StoredFileRecord {
    return fromDoc<StoredFileRecord>(doc);
  }

  private scopeFilter(ownerId: string, scope: StoredScope): Record<string, unknown> {
    return { ownerId, 'scope.kind': scope.kind, 'scope.id': scope.id };
  }

  private async scopeRecords(ownerId: string, scope: StoredScope, session?: ClientSession): Promise<StoredFileRecord[]> {
    const docs = await this.stored.find(this.scopeFilter(ownerId, scope), session ? { session } : {}).toArray();
    return docs.map((doc) => this.recordOf(doc));
  }

  async beginStoredFile(record: StoredFileRecord): Promise<void> {
    const { id, ...rest } = record;
    await this.stored.insertOne({ _id: id, ...rest });
  }

  async touchStoredFile(id: string, at: string): Promise<void> {
    await this.stored.updateOne({ _id: id, state: 'uploading' }, { $set: { touchedAt: at } });
  }

  async commitStoredFiles(commits: readonly StoredFileCommit[], options: { replace: boolean }, at: string): Promise<CommitPlan> {
    return this.inTransaction(async (session) => {
      const uploading = await Promise.all(commits.map(async (commit) => {
        const doc = await this.stored.findOne({ _id: commit.id }, { session }) ?? await this.stored.findOne({ objectId: commit.id }, { session });
        return doc ? this.recordOf(doc) : undefined;
      }));
      const scopes = new Map<string, StoredFileRecord[]>();
      for (const record of uploading) {
        if (!record) continue;
        const key = `${record.ownerId}|${record.scope.kind}|${record.scope.id}`;
        if (!scopes.has(key)) scopes.set(key, await this.scopeRecords(record.ownerId, record.scope, session));
      }
      const plan = commitPlan(uploading, commits, (record) => scopes.get(`${record.ownerId}|${record.scope.kind}|${record.scope.id}`) ?? [], options, at);
      if (!plan.ok) return plan;
      if (plan.absorbed.length > 0) await this.stored.deleteMany({ _id: { $in: plan.absorbed } }, { session });
      for (const record of plan.stored) {
        const { id, ...rest } = record;
        await this.stored.replaceOne({ _id: id }, rest, { session });
      }
      return plan;
    });
  }

  async storedFilesIn(ownerId: string, scope: StoredScope): Promise<StoredFileRecord[]> {
    const docs = await this.stored.find({ ...this.scopeFilter(ownerId, scope), state: 'stored' }).toArray();
    return docs.map((doc) => this.recordOf(doc));
  }

  async storedFileById(id: string): Promise<StoredFileRecord | undefined> {
    const doc = await this.stored.findOne({ _id: id });
    return doc ? this.recordOf(doc) : undefined;
  }

  async storedFileByObject(objectId: string): Promise<StoredFileRecord | undefined> {
    const doc = await this.stored.findOne({ objectId });
    return doc ? this.recordOf(doc) : undefined;
  }

  async makeStoredFolder(record: StoredFileRecord): Promise<StoredFolderOutcome> {
    return this.inTransaction(async (session) => {
      const plan = folderPlan(await this.scopeRecords(record.ownerId, record.scope, session), record.path);
      if (!plan.ok) return plan;
      if (plan.exists) return { ok: true, made: false };
      const { id, ...rest } = record;
      await this.stored.insertOne({ _id: id, ...rest }, { session });
      return { ok: true, made: true };
    });
  }

  async moveStoredFiles(ownerId: string, scope: StoredScope, from: string, to: string, at: string): Promise<StoredMoveOutcome> {
    return this.inTransaction(async (session) => {
      const plan = movePlan(await this.scopeRecords(ownerId, scope, session), from, to);
      if (!plan.ok) return plan;
      for (const move of plan.moves) await this.stored.updateOne({ _id: move.id }, { $set: { path: move.path, changedAt: at } }, { session });
      const ids = plan.moves.map((move) => move.id);
      if (ids.length > 0) await this.shares.deleteMany({ fileId: { $in: ids } }, { session });
      return { ok: true, moved: ids.length };
    });
  }

  async moveStoredScope(ownerId: string, from: StoredScope, to: StoredScope, under: string, at: string, tx?: Tx): Promise<number> {
    return this.inTransaction(async (session) => {
      const moves = scopeMovePlan(await this.scopeRecords(ownerId, from, session), under);
      for (const move of moves) await this.stored.updateOne({ _id: move.id }, { $set: { scope: to, path: move.path, changedAt: at } }, { session });
      const ids = moves.map((move) => move.id);
      if (ids.length > 0) await this.shares.deleteMany({ fileId: { $in: ids } }, { session });
      return ids.length;
    }, tx);
  }

  async deleteStoredFiles(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.inTransaction(async (session) => {
      await this.stored.deleteMany({ _id: { $in: [...ids] } }, { session });
      await this.shares.deleteMany({ fileId: { $in: [...ids] } }, { session });
    });
  }

  async deadStoredUploads(touchedBefore: string): Promise<StoredFileRecord[]> {
    const docs = await this.stored.find({ state: 'uploading', touchedAt: { $lte: touchedBefore } }).toArray();
    return docs.map((doc) => this.recordOf(doc));
  }

  async expiredStoredFiles(now: string): Promise<StoredFileRecord[]> {
    const docs = await this.stored.find({ expiresAt: { $lte: now } }).toArray();
    return docs.map((doc) => this.recordOf(doc));
  }

  async storedObjectIdsAmong(objectIds: readonly string[]): Promise<string[]> {
    if (objectIds.length === 0) return [];
    const docs = await this.stored.find({ objectId: { $in: [...objectIds] } }).project<{ objectId: string }>({ _id: 0, objectId: 1 }).toArray();
    return [...new Set(docs.map((doc) => doc.objectId))];
  }

  async storedFilesOwnedBy(ownerId: string): Promise<StoredFileRecord[]> {
    const docs = await this.stored.find({ ownerId }).toArray();
    return docs.map((doc) => this.recordOf(doc));
  }

  async reownRunFiles(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number> {
    if (from === to || (runIds && runIds.length === 0)) return 0;
    const { modifiedCount } = await this.stored.updateMany(
      { ownerId: from, 'scope.kind': 'run', ...(runIds ? { 'scope.id': { $in: [...runIds] } } : {}) },
      { $set: { ownerId: to } },
    );
    return modifiedCount;
  }

  async *oldArtifacts(): AsyncIterable<OldArtifact> {
    const artifacts = this.db().collection<{ _id: string; ownerId?: string; runId?: string; name?: string; contentType?: string }>('artifacts');
    const chunks = this.db().collection<{ artifactId: string; n: number; data: { buffer: ArrayBuffer } | Buffer }>('artifactChunks');
    for await (const artifact of artifacts.find({})) {
      if (!artifact.ownerId) continue;
      const parts = await chunks.find({ artifactId: artifact._id }).sort({ n: 1 }).toArray();
      const bytes = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data.buffer))));
      yield { ownerId: artifact.ownerId, runId: artifact.runId ?? '', name: artifact.name ?? '', contentType: artifact.contentType || 'application/octet-stream', bytes };
    }
  }

  async forgetOldArtifacts(): Promise<number> {
    const gone = await this.db().collection('artifacts').countDocuments();
    await this.db().collection('artifacts').drop().catch(ignore('there were no old artifacts to forget'));
    await this.db().collection('artifactChunks').drop().catch(ignore('there were no old artifact pieces to forget'));
    return gone;
  }
}
