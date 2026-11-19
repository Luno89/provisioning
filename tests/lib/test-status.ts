import { resolve } from 'node:path';
import { dueQuiet, liveRuns, QUIET_AFTER_MS, statusReport, type Told } from './test-runs.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function watch(group: string, after: number, parent: number): void {
  const told = new Map<string, Told>();
  const look = (): void => {
    if (!alive(parent)) process.exit(0);
    for (const line of dueQuiet(liveRuns().filter((run) => run.group === group), Date.now(), told, after)) console.log(`  ${line}`);
  };
  setInterval(look, Math.min(after / 4, 15_000));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [mode, group, after, parent] = process.argv.slice(2);
  if (mode === 'watch') {
    if (!group || !parent) throw new Error('watch needs a group and the pid of the process it watches for');
    watch(group, after ? Number(after) : QUIET_AFTER_MS, Number(parent));
  } else {
    for (const line of statusReport(liveRuns(), Date.now())) console.log(line);
  }
}
