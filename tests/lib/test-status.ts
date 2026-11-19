import { resolve } from 'node:path';
import { followQuiet, runsIn } from './quiet-follow.js';
import { liveRuns, QUIET_AFTER_MS, runsDir, statusReport } from './test-runs.js';

const USAGE = 'usage: npm run test:status [-- --follow [--after <ms>]]';

function afterOf(args: readonly string[]): number {
  const at = args.indexOf('--after');
  if (at < 0) return QUIET_AFTER_MS;
  const after = Number(args[at + 1]);
  if (!Number.isFinite(after) || after <= 0) throw new Error(USAGE);
  return after;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const [mode, group, after] = args;
  if (mode === 'watch') {
    if (!group) throw new Error('watch needs the group of the run it watches for');
    followQuiet(runsIn(runsDir()), ({ line }) => console.log(`  ${line}`), { group, after: after ? Number(after) : QUIET_AFTER_MS });
    process.stdin.once('end', () => process.exit(0));
    process.stdin.resume();
  } else if (mode === '--follow') {
    for (const line of statusReport(liveRuns(), Date.now())) console.log(line);
    followQuiet(runsIn(runsDir()), ({ run, line }) => console.log(`${run.checkout} · ${run.workspace} · pid ${run.pid} › ${line}`), { after: afterOf(args) });
  } else if (mode === undefined) {
    for (const line of statusReport(liveRuns(), Date.now())) console.log(line);
  } else {
    throw new Error(USAGE);
  }
}
