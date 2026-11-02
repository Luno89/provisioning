import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import { isMainThread } from 'node:worker_threads';

const dir = process.env.COUPLING_LIVE_DIR;
const entry = process.argv[1] ?? '';
const koala = /\/apps\/backend\/src\/(index|worker-[a-z]+)\.ts$/.test(entry);

if (dir && process.env.NODE_V8_COVERAGE && isMainThread && koala) {
  const pids = join(dir, 'pids');
  mkdirSync(pids, { recursive: true });
  writeFileSync(join(pids, String(process.pid)), entry);
  process.on('SIGUSR2', () => {
    v8.takeCoverage();
    writeFileSync(join(pids, `${process.pid}.taken`), String(Date.now()));
  });
}
