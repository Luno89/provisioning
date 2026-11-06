import { readFile } from 'fs/promises';
import path from 'path';
import { ProcessFailed, nodeProcesses, succeeded, type Processes } from '../../platform/index.js';

export class MachineBundle {
  private building: Promise<string> | undefined;

  constructor(
    private readonly repoRoot: string,
    private readonly outDir: string = path.join(repoRoot, 'apps/backend/data/machine-agent'),
    private readonly processes: Processes = nodeProcesses,
  ) {}

  path(): Promise<string> {
    if (!this.building) {
      this.building = succeeded(this.processes, { command: process.execPath, args: [path.join(this.repoRoot, 'apps/local-agent/scripts/bundle-machine.mjs'), this.outDir], cwd: this.repoRoot })
        .then((stdout) => stdout.trim().split('\n').pop()!)
        .catch((err: Error) => {
          this.building = undefined;
          const said = err instanceof ProcessFailed ? err.result.stderr.trim() : '';
          throw new Error(`the machine agent could not be built: ${said || err.message}`);
        });
    }
    return this.building;
  }

  async sha256(): Promise<string> {
    const tarball = await this.path();
    return (await readFile(`${tarball}.sha256`, 'utf8')).trim().split(/\s+/)[0]!;
  }
}
