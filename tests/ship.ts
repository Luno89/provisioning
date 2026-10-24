import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MECHANICS_CHECKS } from '../apps/backend/src/eval/level2/mechanics.js';
import { SHIP_STEPS, shippedThrough } from './lib/gates.js';
import { changedNow, commitLedger, devStackProblem, git, minutesSince, pushedGates, readRecord, runSteps, writeRecord } from './lib/gate-runs.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const PUSH = !process.argv.includes('--no-push');

async function main(): Promise<void> {
  const admin = process.env.MECHANICS_ADMIN;
  if (!admin) throw new Error('set MECHANICS_ADMIN to the admin whose invites, model and agents the suites use');
  const branch = git(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error(`ship runs on main, and this checkout is on ${branch}`);
  const changed = changedNow(REPO);
  if (changed.length > 0) throw new Error(`commit or set aside what is not committed first: ${changed.join(', ')}`);
  const stack = await devStackProblem(REPO);
  if (stack) throw new Error(stack);

  const commit = git(REPO, ['rev-parse', 'HEAD']);
  const record = readRecord(REPO, commit) ?? { commit };
  const already = shippedThrough(pushedGates(REPO, commit));
  if (already) {
    console.log(`${commit.slice(0, 12)} already shipped at ${already.at}`);
    if (!record.shipped) writeRecord(REPO, { ...record, shipped: already });
  } else {
    console.log(`ship ${commit.slice(0, 12)}: the first two gates against the dev stack, which runs this checkout. Leave it as it is until this ends; work elsewhere.`);
    const started = Date.now();
    const steps = runSteps(REPO, commit, SHIP_STEPS, {
      GROVE_LIVE_OWNER: admin,
      CHECKS_LIVE_OWNER: admin,
      INSTANCE_LIVE_OWNER: admin,
      CHECKS_LIVE_SCENARIOS: MECHANICS_CHECKS().map((scenario) => scenario.id).join(','),
    });
    writeRecord(REPO, { ...record, shipped: { at: new Date().toISOString(), steps } });
    console.log(`\n✓ ${commit.slice(0, 12)} shipped: ${steps.length} steps in ${minutesSince(started)} min`);
  }

  if (commitLedger(REPO, `The live ledger records ${commit.slice(0, 12)} passing ship`)) console.log('the live ledger is committed on top');
  if (!PUSH) {
    console.log('not pushed (--no-push)');
    return;
  }
  const pushed = spawnSync('git', ['push', 'origin', 'main'], { cwd: REPO, stdio: 'inherit' });
  if (pushed.status !== 0) throw new Error('git push failed');
}

main().catch((err: Error) => {
  console.error(`\n✗ ship: ${err.message}`);
  process.exit(1);
});
