import { type AreaStore, type Identified, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db, Document } from 'mongodb';
import type { OdooRelease } from './lib/odoo-release.js';
import type { PartialInfo, PipelineRunMetadata } from '../platform/index.js';
import { mergeRecord } from '../platform/lib/merge-record.js';
import { v4 as uuidv4 } from 'uuid';

export interface ReleasesStore extends AreaStore {
  getPipelineRuns(): Promise<PipelineRunMetadata[]>;
  savePipelineRun(run: PipelineRunMetadata): Promise<void>;
  savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata>;
  getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]>;
  saveOdooRelease(release: OdooRelease): Promise<void>;
  markOdooReleaseTold(id: string, updatedAt: string): Promise<boolean>;
  markOdooReleasesTold(): Promise<number>;
}

type Stored = Document & { _id: string };

async function put(collection: Collection<Stored>, entity: Identified): Promise<void> {
  const { _id, ...rest } = toDoc(entity);
  await collection.replaceOne({ _id: entity.id }, rest, { upsert: true });
}

export class MongoReleasesStore implements ReleasesStore {
  constructor(private readonly db: () => Db) {}

  private get odooReleases(): Collection<Stored> {
    return this.db().collection<Stored>('odooReleases');
  }

  private get pipelineRuns(): Collection<Stored> {
    return this.db().collection<Stored>('pipelineRuns');
  }

  async ensureIndexes(): Promise<void> {
    await this.pipelineRuns.createIndex({ projectId: 1 });
    await this.odooReleases.createIndex({ ownerId: 1, projectId: 1 });
  }

  async getPipelineRuns(): Promise<PipelineRunMetadata[]> {
    return (await this.pipelineRuns.find({}).toArray()).map(doc => fromDoc<PipelineRunMetadata>(doc));
  }

  async savePipelineRun(run: PipelineRunMetadata): Promise<void> {
    await put(this.pipelineRuns, run);
  }

  async savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata> {
    const id = run.id || uuidv4();
    const previous = (await this.getPipelineRuns()).find((x: PipelineRunMetadata) => x.id === id);
    const merged = mergeRecord(previous, run as Partial<PipelineRunMetadata>);
    const r: PipelineRunMetadata = {
      ...merged,

      id: id,
      projectId: merged.projectId || '',
      commitSha: merged.commitSha || '',
      ref: merged.ref || '',
      status: merged.status || 'queued',
      startedAt: merged.startedAt || new Date().toISOString(),
    };
    await this.savePipelineRun(r);
    return r;
  }

  async getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]> {
    const docs = await this.odooReleases.find({ ownerId, ...(projectId ? { projectId } : {}) }).sort({ startedAt: -1 }).toArray();
    return docs.map((d) => fromDoc<OdooRelease>(d));
  }

  async saveOdooRelease(release: OdooRelease): Promise<void> {
    await put(this.odooReleases, release);
  }

  async markOdooReleaseTold(id: string, updatedAt: string): Promise<boolean> {
    const result = await this.odooReleases.updateOne({ _id: id, updatedAt }, { $set: { toldAt: updatedAt } });
    return result.modifiedCount === 1;
  }

  async markOdooReleasesTold(): Promise<number> {
    const result = await this.odooReleases.updateMany({ toldAt: { $exists: false } }, [{ $set: { toldAt: '$updatedAt' } }]);
    return result.modifiedCount;
  }
}
