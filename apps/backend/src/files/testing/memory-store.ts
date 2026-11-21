import { DELETING_SAID, projectsOf, type HoldOpen } from '../store.js';
import { NO_TX } from '../../platform/lib/transaction.js';
import { collectionIn, MemoryRecords, type Collections } from '../../platform/testing/memory-records.js';
import type { FileShare } from '../lib/file-shares.js';
import { commitPlan, folderPlan, movePlan, sameScope, scopeMovePlan, type CommitPlan, type StoredFileCommit, type StoredFileRecord, type StoredScope } from '../lib/stored-files.js';
import type { OldArtifact } from '../lib/files-archive.js';
import type { FilesStore, StoredFolderOutcome, StoredMoveOutcome } from '../store.js';

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class MemoryFilesStore implements FilesStore {
  private readonly shares: MemoryRecords<FileShare>;
  private readonly stored: MemoryRecords<StoredFileRecord>;

  constructor(collections: Collections = new Map()) {
    this.shares = new MemoryRecords(collectionIn<FileShare>(collections, 'fileShares'));
    this.stored = new MemoryRecords(collectionIn<StoredFileRecord>(collections, 'storedFiles'));
  }

  async ensureIndexes(): Promise<void> {}

  async getFileShares(ownerId: string): Promise<FileShare[]> {
    return this.shares
      .all()
      .filter((share) => share.ownerId === ownerId)
      .sort((a, b) => ascending(b.createdAt, a.createdAt));
  }

  async getFileShare(id: string): Promise<FileShare | undefined> {
    return this.shares.get(id);
  }

  async getFileShareByToken(token: string): Promise<FileShare | undefined> {
    return this.shares.all().find((share) => share.token === token);
  }

  async saveFileShare(share: FileShare): Promise<void> {
    if (this.shares.all().some((other) => other.id !== share.id && other.token === share.token)) {
      throw new Error('E11000 duplicate key error: a share link already has this token');
    }
    this.shares.put(share);
  }

  async deleteFileShare(id: string): Promise<void> {
    this.shares.delete(id);
  }

  async sealShareTokens(): Promise<number> {
    return 0;
  }

  private scopeRecords(ownerId: string, scope: StoredScope): StoredFileRecord[] {
    return this.stored.all().filter((record) => record.ownerId === ownerId && sameScope(record.scope, scope));
  }

  private dropSharesOf(ids: readonly string[]): void {
    for (const share of this.shares.all()) if (share.fileId && ids.includes(share.fileId)) this.shares.delete(share.id);
  }

  async beginStoredFile(record: StoredFileRecord): Promise<void> {
    if (this.stored.get(record.id)) throw new Error(`E11000 duplicate key error: a stored file already has the id ${record.id}`);
    this.stored.put(record);
  }

  async touchStoredFile(id: string, at: string): Promise<void> {
    const record = this.stored.get(id);
    if (record?.state === 'uploading') this.stored.put({ ...record, touchedAt: at });
  }

  async commitStoredFiles(commits: readonly StoredFileCommit[], options: { replace: boolean; holdOpen: HoldOpen }, at: string): Promise<CommitPlan> {
    const uploading = commits.map((commit) => this.stored.get(commit.id) ?? this.byObject(commit.id));
    for (const projectId of projectsOf(uploading)) {
      if (!(await options.holdOpen(NO_TX, projectId))) return { ok: false, status: 409, why: DELETING_SAID };
    }
    const plan = commitPlan(uploading, commits, (record) => this.scopeRecords(record.ownerId, record.scope), options, at);
    if (!plan.ok) return plan;
    for (const id of plan.absorbed) this.stored.delete(id);
    for (const record of plan.stored) this.stored.put(record);
    return plan;
  }

  async storedFilesIn(ownerId: string, scope: StoredScope): Promise<StoredFileRecord[]> {
    return this.scopeRecords(ownerId, scope).filter((record) => record.state === 'stored');
  }

  async storedFileById(id: string): Promise<StoredFileRecord | undefined> {
    return this.stored.get(id);
  }

  private byObject(objectId: string): StoredFileRecord | undefined {
    return this.stored.all().find((record) => record.objectId === objectId);
  }

  async storedFileByObject(objectId: string): Promise<StoredFileRecord | undefined> {
    return this.byObject(objectId);
  }

  async makeStoredFolder(record: StoredFileRecord): Promise<StoredFolderOutcome> {
    const plan = folderPlan(this.scopeRecords(record.ownerId, record.scope), record.path);
    if (!plan.ok) return plan;
    if (plan.exists) return { ok: true, made: false };
    this.stored.put(record);
    return { ok: true, made: true };
  }

  async moveStoredFiles(ownerId: string, scope: StoredScope, from: string, to: string, at: string): Promise<StoredMoveOutcome> {
    const plan = movePlan(this.scopeRecords(ownerId, scope), from, to);
    if (!plan.ok) return plan;
    for (const move of plan.moves) this.stored.put({ ...this.stored.get(move.id)!, path: move.path, changedAt: at });
    this.dropSharesOf(plan.moves.map((move) => move.id));
    return { ok: true, moved: plan.moves.length };
  }

  async moveStoredScope(ownerId: string, from: StoredScope, to: StoredScope, under: string, at: string, _tx?: unknown): Promise<number> {
    const moves = scopeMovePlan(this.scopeRecords(ownerId, from), under);
    for (const move of moves) this.stored.put({ ...this.stored.get(move.id)!, scope: { ...to }, path: move.path, changedAt: at });
    this.dropSharesOf(moves.map((move) => move.id));
    return moves.length;
  }

  async deleteStoredFiles(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.stored.delete(id);
    this.dropSharesOf(ids);
  }

  async deadStoredUploads(touchedBefore: string): Promise<StoredFileRecord[]> {
    return this.stored.all().filter((record) => record.state === 'uploading' && record.touchedAt <= touchedBefore);
  }

  async expiredStoredFiles(now: string): Promise<StoredFileRecord[]> {
    return this.stored.all().filter((record) => record.expiresAt !== undefined && record.expiresAt <= now);
  }

  async storedObjectIdsAmong(objectIds: readonly string[]): Promise<string[]> {
    const named = new Set(this.stored.all().map((record) => record.objectId));
    return [...new Set(objectIds.filter((objectId) => named.has(objectId)))];
  }

  async storedFilesOwnedBy(ownerId: string): Promise<StoredFileRecord[]> {
    return this.stored.all().filter((record) => record.ownerId === ownerId);
  }

  async reownRunFiles(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number> {
    if (from === to || (runIds && runIds.length === 0)) return 0;
    const moving = this.stored.all().filter((record) => record.ownerId === from && record.scope.kind === 'run' && (!runIds || runIds.includes(record.scope.id)));
    for (const record of moving) this.stored.put({ ...record, ownerId: to });
    return moving.length;
  }

  readonly old: OldArtifact[] = [];

  async *oldArtifacts(): AsyncIterable<OldArtifact> {
    for (const artifact of [...this.old]) yield { ...artifact, bytes: Buffer.from(artifact.bytes) };
  }

  async forgetOldArtifacts(): Promise<number> {
    return this.old.splice(0, this.old.length).length;
  }
}
