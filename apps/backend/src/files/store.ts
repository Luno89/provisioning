import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { ArtifactChunk, StoredArtifact } from './lib/artifacts.js';
import type { Collection, Db } from 'mongodb';
import type { FileSettings } from './lib/file-places.js';
import type { FileShare } from './lib/file-shares.js';

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
  saveFileShare(share: FileShare): Promise<void>;
  deleteFileShare(id: string): Promise<void>;
}

export class MongoFilesStore implements FilesStore {
  constructor(private readonly db: () => Db) {}

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
    const docs = await this.db().collection('fileShares').find({ ownerId }).sort({ createdAt: -1 }).toArray();
    return docs.map(({ _id, ...rest }) => ({ ...(rest as Omit<FileShare, 'id'>), id: String(_id) }));
  }

  async getFileShare(id: string): Promise<FileShare | undefined> {
    const doc = await this.db().collection('fileShares').findOne({ _id: id as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc;
    return { ...(rest as Omit<FileShare, 'id'>), id: String(_id) };
  }

  async saveFileShare(share: FileShare): Promise<void> {
    const { id, ...rest } = share;
    await this.db().collection('fileShares').replaceOne({ _id: id as never }, rest, { upsert: true });
  }

  async deleteFileShare(id: string): Promise<void> {
    await this.db().collection('fileShares').deleteOne({ _id: id as never });
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
