import { randomUUID } from 'node:crypto';
import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import { decryptValue, encryptValue, type SecretKey } from '../platform/lib/crypto.js';
import type { ArtifactChunk, StoredArtifact } from './lib/artifacts.js';
import type { Collection, Db } from 'mongodb';
import type { FileSettings } from './lib/file-places.js';
import { shareTokenHash, type FileShare } from './lib/file-shares.js';

export interface FilesStore extends AreaStore {
  saveArtifact(artifact: StoredArtifact): Promise<void>;
  getArtifacts(ownerId: string, runId?: string): Promise<StoredArtifact[]>;
  getExpiredArtifacts(now: string): Promise<StoredArtifact[]>;
  deleteArtifact(id: string): Promise<void>;
  saveArtifactChunk(chunk: ArtifactChunk): Promise<void>;
  getArtifactChunks(artifactId: string): Promise<ArtifactChunk[]>;
  deleteArtifactChunks(artifactId: string): Promise<void>;
  getFileSettings(ownerId: string): Promise<FileSettings | undefined>;
  saveFileSettings(settings: FileSettings): Promise<void>;
  getFileShares(ownerId: string): Promise<FileShare[]>;
  getFileShare(id: string): Promise<FileShare | undefined>;
  getFileShareByToken(token: string): Promise<FileShare | undefined>;
  saveFileShare(share: FileShare): Promise<void>;
  deleteFileShare(id: string): Promise<void>;
  sealShareTokens(): Promise<number>;
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

  private get artifactChunks(): Collection {
    return this.db().collection('artifactChunks');
  }

  private get artifacts(): Collection {
    return this.db().collection('artifacts');
  }

  async ensureIndexes(): Promise<void> {
    await this.artifacts.createIndex({ ownerId: 1, runId: 1 });
    await this.artifacts.createIndex({ expiresAt: 1 });
    await this.artifactChunks.createIndex({ artifactId: 1, n: 1 });
    await this.shares.createIndex({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $exists: true } } });
  }

  async saveArtifact(artifact: StoredArtifact): Promise<void> {
    const { _id, ...rest } = toDoc(artifact);
    await this.artifacts.replaceOne({ _id }, rest, { upsert: true });
  }

  async getArtifacts(ownerId: string, runId?: string): Promise<StoredArtifact[]> {
    const docs = await this.artifacts.find({ ownerId, ...(runId ? { runId } : {}) }).sort({ createdAt: 1 }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<StoredArtifact>(d));
  }

  async getExpiredArtifacts(now: string): Promise<StoredArtifact[]> {
    const docs = await this.artifacts.find({ expiresAt: { $lte: now } }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<StoredArtifact>(d));
  }

  async deleteArtifact(id: string): Promise<void> {
    await this.artifacts.deleteOne({ _id: id as never });
  }

  async saveArtifactChunk(chunk: ArtifactChunk): Promise<void> {
    await this.artifactChunks.replaceOne({ _id: `${chunk.artifactId}:${chunk.n}` as never }, { artifactId: chunk.artifactId, ownerId: chunk.ownerId, n: chunk.n, data: chunk.data }, { upsert: true });
  }

  async getArtifactChunks(artifactId: string): Promise<ArtifactChunk[]> {
    const docs = await this.artifactChunks.find({ artifactId }).sort({ n: 1 }).toArray();
    return docs.map((d) => ({ artifactId: d.artifactId as string, ownerId: d.ownerId as string, n: d.n as number, data: Buffer.from((d.data as { buffer: ArrayBuffer }).buffer ?? d.data) }));
  }

  async deleteArtifactChunks(artifactId: string): Promise<void> {
    await this.artifactChunks.deleteMany({ artifactId });
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

  async getFileSettings(ownerId: string): Promise<FileSettings | undefined> {
    const doc = await this.db().collection('fileSettings').findOne({ _id: ownerId as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc;
    return { ...(rest as Omit<FileSettings, 'ownerId'>), ownerId: String(_id) };
  }

  async saveFileSettings(settings: FileSettings): Promise<void> {
    const { ownerId, ...rest } = settings;
    await this.db().collection('fileSettings').replaceOne({ _id: ownerId as never }, rest, { upsert: true });
  }
}
