import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';

const dir = process.env.COUPLING_LIVE_DIR;
if (dir && process.env.NODE_V8_COVERAGE) {
  const pids = join(dir, 'pids');
  mkdirSync(pids, { recursive: true });
  writeFileSync(join(pids, String(process.pid)), process.argv.slice(1).join(' '));
  process.on('SIGUSR2', () => {
    v8.takeCoverage();
    writeFileSync(join(pids, `${process.pid}.taken`), String(Date.now()));
  });
}
