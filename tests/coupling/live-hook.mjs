import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import { isMainThread } from 'node:worker_threads';

const dir = process.env.COUPLING_LIVE_DIR;
const entry = process.argv[1] ?? '';
const koala = /\/apps\/backend\/src\/(index|worker-[a-z]+)\.ts$/.test(entry);

if (dir && process.env.NODE_V8_COVERAGE && isMainThread && koala) {
  const pids = join(dir, 'pids');
  const request = join(dir, 'request');
  mkdirSync(pids, { recursive: true });
  writeFileSync(join(pids, String(process.pid)), entry);
  let answered = '';
  const answer = () => {
    let asked = '';
    try {
      asked = readFileSync(request, 'utf8').trim();
    } catch {
      return;
    }
    if (!asked || asked === answered) return;
    answered = asked;
    v8.takeCoverage();
    writeFileSync(join(pids, `${process.pid}.taken`), asked);
  };
  watch(dir, (_event, name) => { if (name === 'request') answer(); }).unref();
}
