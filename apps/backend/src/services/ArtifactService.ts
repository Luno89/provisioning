import { v4 as uuidv4 } from 'uuid';
import { chunksOf, contentTypeOf, expiresFrom, objectKey, withinBudget, type ArtifactPlace, type StoredArtifact } from '../lib/artifacts.js';

export interface ArtifactChunk {
  artifactId: string;
  ownerId: string;
  n: number;
  data: Buffer;
}

export interface ArtifactRecords {
  saveArtifact(artifact: StoredArtifact): Promise<void>;
  getArtifacts(ownerId: string, runId?: string): Promise<StoredArtifact[]>;
  getExpiredArtifacts(now: string): Promise<StoredArtifact[]>;
  deleteArtifact(id: string): Promise<void>;
  saveArtifactChunk(chunk: ArtifactChunk): Promise<void>;
  getArtifactChunks(artifactId: string): Promise<ArtifactChunk[]>;
  deleteArtifactChunks(artifactId: string): Promise<void>;
}

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export interface ArtifactFile {
  name: string;
  bytes: Buffer;
  contentType?: string | undefined;
}

export interface StoredArtifacts {
  stored: StoredArtifact[];
  dropped: string[];
  place: ArtifactPlace;
  minioMissing: boolean;
}

export interface ArtifactDeps {
  records: ArtifactRecords;
  minioFor: (ownerId: string) => Promise<ObjectStore | undefined>;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

export class ArtifactService {
  constructor(private readonly deps: ArtifactDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  async put(ownerId: string, runId: string, files: readonly ArtifactFile[]): Promise<StoredArtifacts> {
    const used = (await this.deps.records.getArtifacts(ownerId, runId)).reduce((sum, artifact) => sum + artifact.size, 0);
    const { kept, dropped } = withinBudget(files.map((file) => ({ ...file, size: file.bytes.length })), used);
    const minio = await this.deps.minioFor(ownerId).catch(() => undefined);
    const place: ArtifactPlace = minio ? 'minio' : 'mongo';
    const stamp = this.now();
    const stored: StoredArtifact[] = [];

    for (const file of kept) {
      const artifact: StoredArtifact = {
        id: (this.deps.newId ?? uuidv4)(),
        ownerId,
        runId,
        name: file.name,
        contentType: file.contentType ?? contentTypeOf(file.name),
        size: file.size,
        place,
        createdAt: stamp,
        expiresAt: expiresFrom(stamp),
      };
      if (minio) await minio.put(objectKey(artifact), file.bytes, artifact.contentType);
      else {
        for (const [n, data] of chunksOf(file.bytes).entries()) await this.deps.records.saveArtifactChunk({ artifactId: artifact.id, ownerId, n, data });
      }
      await this.deps.records.saveArtifact(artifact);
      stored.push(artifact);
    }
    return { stored, dropped: dropped.map((file) => file.name), place, minioMissing: !minio };
  }

  async list(ownerId: string, runId: string): Promise<StoredArtifact[]> {
    return this.deps.records.getArtifacts(ownerId, runId);
  }

  async get(ownerId: string, id: string): Promise<{ artifact: StoredArtifact; bytes: Buffer } | undefined> {
    const artifact = (await this.deps.records.getArtifacts(ownerId)).find((entry) => entry.id === id);
    if (!artifact) return undefined;
    if (artifact.place === 'minio') {
      const minio = await this.deps.minioFor(ownerId);
      if (!minio) throw new Error('this artifact is kept in MinIO, which is not reachable now');
      return { artifact, bytes: await minio.get(objectKey(artifact)) };
    }
    const chunks = (await this.deps.records.getArtifactChunks(id)).sort((a, b) => a.n - b.n);
    return { artifact, bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data))) };
  }

  async sweep(): Promise<number> {
    const expired = await this.deps.records.getExpiredArtifacts(this.now());
    for (const artifact of expired) {
      if (artifact.place === 'minio') {
        const minio = await this.deps.minioFor(artifact.ownerId).catch(() => undefined);
        await minio?.remove(objectKey(artifact)).catch(() => undefined);
      } else await this.deps.records.deleteArtifactChunks(artifact.id);
      await this.deps.records.deleteArtifact(artifact.id);
    }
    return expired.length;
  }
}
