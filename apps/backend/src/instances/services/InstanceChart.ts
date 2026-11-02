import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);

export type RunProgram = (command: string, args: string[], options?: { cwd?: string }) => Promise<unknown>;

const runOnThisMachine: RunProgram = (command, args, options) => execFileAsync(command, args, options ?? {});

export class InstanceChart {
  private packaged: Promise<string> | undefined;

  constructor(private readonly repoRoot: string, private readonly run: RunProgram = runOnThisMachine) {}

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
      await this.run(resolve(this.repoRoot, 'bin/helm'), ['package', this.chartDir, '-d', out]);
      const [file] = (await readdir(out)).filter((name) => name.endsWith('.tgz'));
      if (!file) throw new Error('helm package wrote no chart');
      return join(out, file);
    })();
    this.packaged.catch(() => { this.packaged = undefined; });
    return this.packaged;
  }
}

export async function releaseInventory(repoRoot: string, release: string, out: string, run: RunProgram = runOnThisMachine): Promise<void> {
  await run(process.execPath, [resolve(repoRoot, 'scripts/deps-inventory.mjs'), '--release', release, '--out', out], { cwd: repoRoot });
}
