import { randomUUID } from 'node:crypto';
import type { PartialInfo, PipelineRunMetadata } from '../../platform/index.js';
import { mergeRecord } from '../../platform/lib/merge-record.js';
import { asStored } from '../../platform/testing/as-stored.js';
import { MemoryRecords } from '../../platform/testing/memory-records.js';
import type { OdooRelease } from '../lib/odoo-release.js';
import type { ReleasesStore } from '../store.js';

export class MemoryReleasesStore implements ReleasesStore {
  private readonly pipelineRuns = new MemoryRecords<PipelineRunMetadata>();
  private readonly odooReleases = new MemoryRecords<OdooRelease>();

  async ensureIndexes(): Promise<void> {}

  async getPipelineRuns(): Promise<PipelineRunMetadata[]> {
    return this.pipelineRuns.all();
  }

  async savePipelineRun(run: PipelineRunMetadata): Promise<void> {
    this.pipelineRuns.put(asStored(run));
  }

  async savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata> {
    const id = run.id || randomUUID();
    const previous = this.pipelineRuns.get(id);
    const merged = mergeRecord(previous, run as Partial<PipelineRunMetadata>);
    const saved: PipelineRunMetadata = {
      ...merged,
      id,
      projectId: merged.projectId || '',
      commitSha: merged.commitSha || '',
      ref: merged.ref || '',
      status: merged.status || 'queued',
      startedAt: merged.startedAt || new Date().toISOString(),
    };
    await this.savePipelineRun(saved);
    return structuredClone(saved);
  }

  async getOdooReleases(ownerId: string, projectId?: string): Promise<OdooRelease[]> {
    return this.odooReleases.all()
      .filter((release) => release.ownerId === ownerId && (!projectId || release.projectId === projectId))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  async saveOdooRelease(release: OdooRelease): Promise<void> {
    this.odooReleases.put(asStored(release));
  }

  async markOdooReleaseTold(id: string, updatedAt: string): Promise<boolean> {
    return this.odooReleases.change(id, (release) => {
      if (release.updatedAt !== updatedAt || release.toldAt === updatedAt) return undefined;
      return { ...release, toldAt: updatedAt };
    });
  }

  async markOdooReleasesTold(): Promise<number> {
    let changed = 0;
    for (const release of this.odooReleases.all()) {
      if ('toldAt' in release) continue;
      this.odooReleases.put({ ...release, toldAt: release.updatedAt });
      changed += 1;
    }
    return changed;
  }
}
