import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { releaseFromTag, type InstanceRelease } from '../lib/instance-updates.js';
import type { InstancesStore } from '../store.js';
import type { ReleaseSource } from './InstanceService.js';

const run = promisify(execFile);
const IMAGE_TAG = /^[A-Za-z0-9._-]{1,128}$/;

export interface ReleaseCatalogueSettings {
  repoRoot: string;
  chartsDir: string;
  imageTag: string;
  chart: () => Promise<string>;
}

export class ReleaseCatalogue implements ReleaseSource {
  constructor(
    private readonly store: Pick<InstancesStore, 'getReleases' | 'recordRelease'>,
    private readonly settings: ReleaseCatalogueSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async git(args: string[]): Promise<string | undefined> {
    try {
      return (await run('git', args, { cwd: this.settings.repoRoot })).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async recordCurrent(): Promise<InstanceRelease> {
    const { imageTag } = this.settings;
    const tag = await this.git(['describe', '--exact-match', '--tags', '--match', 'v*', 'HEAD']);
    const message = tag ? await this.git(['tag', '--list', '--format=%(contents)', tag]) : undefined;
    const release = await this.store.recordRelease(releaseFromTag(imageTag, tag, message, this.now().toISOString()));
    if (IMAGE_TAG.test(imageTag)) {
      await mkdir(this.settings.chartsDir, { recursive: true });
      await copyFile(await this.settings.chart(), join(this.settings.chartsDir, `${imageTag}.tgz`));
    }
    return release;
  }

  releases(): Promise<InstanceRelease[]> {
    return this.store.getReleases();
  }

  chartFile(imageTag: string): string | undefined {
    if (!IMAGE_TAG.test(imageTag)) return undefined;
    const file = join(this.settings.chartsDir, `${imageTag}.tgz`);
    return existsSync(file) ? file : undefined;
  }

  hasChart(imageTag: string): boolean {
    return this.chartFile(imageTag) !== undefined;
  }
}
