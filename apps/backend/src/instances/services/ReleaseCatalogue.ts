import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { releaseFromTag, type InstanceRelease } from '../lib/instance-updates.js';
import type { InstancesStore } from '../store.js';
import type { ReleaseSource } from './InstanceService.js';

const run = promisify(execFile);
const IMAGE_TAG = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface ReleaseCatalogueSettings {
  repoRoot: string;
  chartsDir: string;
  imageTag: string;
  imageDigest?: string | undefined;
  chart: () => Promise<string>;
}

export class ReleaseCatalogue implements ReleaseSource {
  private recorded: Promise<unknown> = Promise.resolve();

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

  recordCurrent(): Promise<InstanceRelease> {
    const recording = this.record();
    this.recorded = recording.catch(() => undefined);
    return recording;
  }

  private async record(): Promise<InstanceRelease> {
    const { imageTag, imageDigest } = this.settings;
    const tag = await this.git(['describe', '--exact-match', '--tags', '--match', 'v*', 'HEAD']);
    const message = tag ? await this.git(['tag', '--list', '--format=%(contents)', tag]) : undefined;
    let chartSha256: string | undefined;
    if (IMAGE_TAG.test(imageTag)) {
      await mkdir(this.settings.chartsDir, { recursive: true });
      const kept = join(this.settings.chartsDir, `${imageTag}.tgz`);
      await copyFile(await this.settings.chart(), kept);
      chartSha256 = createHash('sha256').update(await readFile(kept)).digest('hex');
    }
    return this.store.recordRelease({
      ...releaseFromTag(imageTag, tag, message, this.now().toISOString()),
      ...(imageDigest && DIGEST.test(imageDigest) ? { digest: imageDigest } : {}),
      ...(chartSha256 ? { chartSha256 } : {}),
    });
  }

  async releases(): Promise<InstanceRelease[]> {
    await this.recorded;
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
