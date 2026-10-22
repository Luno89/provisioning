import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db } from 'mongodb';
import type { OdooRelease } from './lib/odoo-release.js';
import type { PartialInfo, PipelineRunMetadata } from '../platform/lib/types.js';
import { mergeRecord } from '../platform/lib/merge-record.js';
import { v4 as uuidv4 } from 'uuid';

export interface ReleasesStore extends AreaStore {
  getPipelineRuns(): Promise<PipelineRunMetadata[]>;
  savePipelineRun(run: PipelineRunMetadata): Promise<void>;
  savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata>;
  getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]>;
  saveOdooRelease(release: OdooRelease): Promise<void>;
}

export class MongoReleasesStore implements ReleasesStore {
  constructor(private readonly db: () => Db) {}

  private get odooReleases(): Collection {
    return this.db().collection('odooReleases');
  }

  private get pipelineRuns(): Collection {
    return this.db().collection('pipelineRuns');
  }

  async ensureIndexes(): Promise<void> {
    await this.pipelineRuns.createIndex({ projectId: 1 });
    await this.odooReleases.createIndex({ ownerId: 1, projectId: 1 });
  }

  async getPipelineRuns(): Promise<PipelineRunMetadata[]> {
    return (await this.pipelineRuns.find({}).toArray()).map(doc => fromDoc<PipelineRunMetadata>(doc));
  }

  async savePipelineRun(run: PipelineRunMetadata): Promise<void> {
    const doc = toDoc(run);
    const id = doc._id;
    const { _id, ...filter } = doc;
    await this.pipelineRuns.replaceOne({ _id: id }, filter, { upsert: true });
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
    return docs.map((d: Record<string, unknown>) => fromDoc<OdooRelease>(d));
  }

  async saveOdooRelease(release: OdooRelease): Promise<void> {
    const doc = toDoc(release);
    const { _id, ...rest } = doc;
    await this.odooReleases.replaceOne({ _id }, rest, { upsert: true });
  }
}
