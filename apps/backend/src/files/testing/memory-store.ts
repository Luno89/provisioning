import { collectionIn, copied, MemoryRecords, type Collections } from '../../platform/testing/memory-records.js';
import type { ArtifactChunk, StoredArtifact } from '../lib/artifacts.js';
import type { FileSettings } from '../lib/file-places.js';
import type { FileShare } from '../lib/file-shares.js';
import type { FilesStore } from '../store.js';

const chunkKey = (artifactId: string, n: number): string => `${artifactId}:${n}`;

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class MemoryFilesStore implements FilesStore {
  private readonly artifacts: MemoryRecords<StoredArtifact>;
  private readonly chunks: Map<string, ArtifactChunk>;
  private readonly settings: Map<string, FileSettings>;
  private readonly shares: MemoryRecords<FileShare>;

  constructor(collections: Collections = new Map()) {
    this.artifacts = new MemoryRecords(collectionIn<StoredArtifact>(collections, 'artifacts'));
    this.chunks = collectionIn<ArtifactChunk>(collections, 'artifactChunks');
    this.settings = collectionIn<FileSettings>(collections, 'fileSettings');
    this.shares = new MemoryRecords(collectionIn<FileShare>(collections, 'fileShares'));
  }

  async ensureIndexes(): Promise<void> {}

  async saveArtifact(artifact: StoredArtifact): Promise<void> {
    this.artifacts.put(artifact);
  }

  async getArtifacts(ownerId: string, runId?: string): Promise<StoredArtifact[]> {
    return this.artifacts
      .all()
      .filter((artifact) => artifact.ownerId === ownerId && (!runId || artifact.runId === runId))
      .sort((a, b) => ascending(a.createdAt, b.createdAt));
  }

  async getExpiredArtifacts(now: string): Promise<StoredArtifact[]> {
    return this.artifacts.all().filter((artifact) => artifact.expiresAt <= now);
  }

  async deleteArtifact(id: string): Promise<void> {
    this.artifacts.delete(id);
  }

  async saveArtifactChunk(chunk: ArtifactChunk): Promise<void> {
    this.chunks.set(chunkKey(chunk.artifactId, chunk.n), { artifactId: chunk.artifactId, ownerId: chunk.ownerId, n: chunk.n, data: Buffer.from(chunk.data) });
  }

  async getArtifactChunks(artifactId: string): Promise<ArtifactChunk[]> {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.artifactId === artifactId)
      .sort((a, b) => a.n - b.n)
      .map((chunk) => ({ ...chunk, data: Buffer.from(chunk.data) }));
  }

  async deleteArtifactChunks(artifactId: string): Promise<void> {
    for (const [key, chunk] of this.chunks) if (chunk.artifactId === artifactId) this.chunks.delete(key);
  }

  async getFileSettings(ownerId: string): Promise<FileSettings | undefined> {
    const stored = this.settings.get(ownerId);
    return stored ? copied(stored) : undefined;
  }

  async saveFileSettings(settings: FileSettings): Promise<void> {
    this.settings.set(settings.ownerId, copied(settings));
  }

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
}
