import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export class MachineBundle {
  private building: Promise<string> | undefined;

  constructor(private readonly repoRoot: string, private readonly outDir: string = path.join(repoRoot, 'apps/local-agent/dist')) {}

  path(): Promise<string> {
    if (!this.building) {
      this.building = run(process.execPath, [path.join(this.repoRoot, 'apps/local-agent/scripts/bundle-machine.mjs'), this.outDir], { cwd: this.repoRoot })
        .then(({ stdout }) => stdout.trim().split('\n').pop()!)
        .catch((err: Error & { stderr?: string }) => {
          this.building = undefined;
          throw new Error(`the machine agent could not be built: ${err.stderr?.trim() || err.message}`);
        });
    }
    return this.building;
  }

  async sha256(): Promise<string> {
    const tarball = await this.path();
    return (await readFile(`${tarball}.sha256`, 'utf8')).trim().split(/\s+/)[0]!;
  }
}
