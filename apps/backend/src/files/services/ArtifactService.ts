import { Readable } from 'node:stream';
import { artifactOf, contentTypeOf, expiresFrom, withinBudget, type StoredArtifact } from '../lib/artifacts.js';
import type { StoredFiles } from './StoredFiles.js';

export interface ArtifactFile {
  name: string;
  bytes: Buffer;
  contentType?: string | undefined;
}

export interface StoredArtifacts {
  stored: StoredArtifact[];
  dropped: string[];
}

export interface ArtifactDeps {
  files: Pick<StoredFiles, 'at' | 'byId' | 'recordById'>;
  now?: (() => string) | undefined;
}

export class ArtifactService {
  constructor(private readonly deps: ArtifactDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  private run(ownerId: string, runId: string) {
    return this.deps.files.at(ownerId, { kind: 'run', id: runId });
  }

  async put(ownerId: string, runId: string, files: readonly ArtifactFile[]): Promise<StoredArtifacts> {
    const folder = this.run(ownerId, runId);
    const used = (await folder.files()).reduce((sum, record) => sum + record.size, 0);
    const { kept, dropped } = withinBudget(files.map((file) => ({ ...file, size: file.bytes.length })), used);
    const expiresAt = expiresFrom(this.now());
    const stored: StoredArtifact[] = [];
    for (const file of kept) {
      const saved = await folder.upload(file.name, Readable.from([file.bytes]), file.size, file.contentType ?? contentTypeOf(file.name), { replace: true, expiresAt });
      if (!saved.ok) throw new Error(`${file.name} of run ${runId} could not be kept: ${saved.why}`);
      stored.push(artifactOf(saved.value));
    }
    return { stored, dropped: dropped.map((file) => file.name) };
  }

  async list(ownerId: string, runId: string): Promise<StoredArtifact[]> {
    return (await this.run(ownerId, runId).files()).map(artifactOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  }

  async get(ownerId: string, id: string): Promise<{ artifact: StoredArtifact; body: Readable } | undefined> {
    const record = await this.deps.files.recordById(ownerId, id);
    if (record?.scope.kind !== 'run') return undefined;
    const found = await this.deps.files.byId(ownerId, id);
    return found ? { artifact: artifactOf(found.record), body: found.body } : undefined;
  }

  async removeRun(ownerId: string, runId: string): Promise<number> {
    return this.run(ownerId, runId).removeAll();
  }
}
