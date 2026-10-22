import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const run = promisify(execFile);

export class InstanceChart {
  private packaged: Promise<string> | undefined;

  constructor(private readonly repoRoot: string) {}

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
      await run(resolve(this.repoRoot, 'bin/helm'), ['package', this.chartDir, '-d', out]);
      const [file] = (await readdir(out)).filter((name) => name.endsWith('.tgz'));
      if (!file) throw new Error('helm package wrote no chart');
      return join(out, file);
    })();
    this.packaged.catch(() => { this.packaged = undefined; });
    return this.packaged;
  }
}
