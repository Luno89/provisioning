import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { nodeProcesses, succeeded, type Processes } from '../../platform/index.js';
import type { ClusterAccess } from '../../infrastructure/index.js';

export class InstanceChart {
  private packaged: Promise<string> | undefined;

  constructor(private readonly repoRoot: string, private readonly charts: Pick<ClusterAccess, 'packageChart'>) {}

  private get chartDir(): string {
    return resolve(this.repoRoot, 'charts/instance');
  }

  async version(): Promise<string> {
    const chart = parse(await readFile(join(this.chartDir, 'Chart.yaml'), 'utf8')) as { version?: string };
    return chart.version ?? '0.0.0';
  }

  path(): Promise<string> {
    this.packaged ??= (async () => {
      const out = await mkdtemp(join(tmpdir(), 'instance-chart-'));
      await this.charts.packageChart(this.chartDir, out);
      const [file] = (await readdir(out)).filter((name) => name.endsWith('.tgz'));
      if (!file) throw new Error('helm package wrote no chart');
      return join(out, file);
    })();
    this.packaged.catch(() => { this.packaged = undefined; });
    return this.packaged;
  }
}

export async function releaseInventory(repoRoot: string, release: string, out: string, processes: Processes = nodeProcesses): Promise<void> {
  await succeeded(processes, { command: process.execPath, args: [resolve(repoRoot, 'scripts/deps-inventory.mjs'), '--release', release, '--out', out], cwd: repoRoot });
}
