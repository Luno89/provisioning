import { type AreaStore, type Identified, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { Collection, Db, Document } from 'mongodb';
import type { OdooRelease } from './lib/odoo-release.js';
import type { PartialInfo, PipelineRunMetadata } from '../platform/index.js';
import { mergeRecord } from '../platform/lib/merge-record.js';
import { v4 as uuidv4 } from 'uuid';
import { keepWrittenDocuments, watchingAll, watchNudges, watchWrites, type Watching } from '../platform/lib/change-streams.js';
import { FOLLOWED_RUN_STATUSES, workflowMatch } from '../infrastructure/lib/followed-work.js';

export interface ReleasesStore extends AreaStore {
  getPipelineRuns(): Promise<PipelineRunMetadata[]>;
  watchLiveRuns(on: (run: PipelineRunMetadata) => void): Watching;
  watchReleaseWork(on: () => void): Watching;
  watchOdooReleases(on: (release: OdooRelease) => void): Watching;
  savePipelineRun(run: PipelineRunMetadata): Promise<void>;
  savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata>;
  getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]>;
  saveOdooRelease(release: OdooRelease): Promise<void>;
  markOdooReleaseTold(id: string, updatedAt: string): Promise<boolean>;
  setOdooReleaseTestsFrom(id: string, commit: string, updatedAt: string): Promise<boolean>;
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
    await keepWrittenDocuments(this.db(), ['pipelineRuns', 'odooReleases']);
    await this.pipelineRuns.createIndex({ projectId: 1 });
    await this.odooReleases.createIndex({ ownerId: 1, projectId: 1 });
  }

  watchLiveRuns(on: (run: PipelineRunMetadata) => void): Watching {
    return watchWrites(() => this.pipelineRuns, workflowMatch(FOLLOWED_RUN_STATUSES), (doc) => on(fromDoc<PipelineRunMetadata>(doc)));
  }

  watchOdooReleases(on: (release: OdooRelease) => void): Watching {
    return watchWrites(() => this.odooReleases, {}, (doc) => on(fromDoc<OdooRelease>(doc)));
  }

  watchReleaseWork(on: () => void): Watching {
    return watchingAll([watchNudges(() => this.pipelineRuns, () => on()), watchNudges(() => this.odooReleases, () => on())]);
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

  async setOdooReleaseTestsFrom(id: string, commit: string, updatedAt: string): Promise<boolean> {
    const result = await this.odooReleases.updateOne({ _id: id }, { $set: { testsFrom: commit, updatedAt } });
    return result.matchedCount === 1;
  }

  async markOdooReleasesTold(): Promise<number> {
    const result = await this.odooReleases.updateMany({ toldAt: { $exists: false } }, [{ $set: { toldAt: '$updatedAt' } }]);
    return result.modifiedCount;
  }
}
