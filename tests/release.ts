import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { nextVersion, RELEASE_STEPS, shippedThrough } from './lib/gates.js';
import { buildAppImage, changedNow, commitLedger, devStackProblem, git, minutesSince, pushedGates, readRecord, runSteps, writeRecord } from './lib/gate-runs.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const PUSH = !process.argv.includes('--no-push');
const named = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

async function main(): Promise<void> {
  const admin = process.env.MECHANICS_ADMIN;
  if (!admin) throw new Error('set MECHANICS_ADMIN to the admin the suites act as');
  const branch = git(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error(`release runs on main, and this checkout is on ${branch}`);
  const changed = changedNow(REPO);
  if (changed.length > 0) throw new Error(`commit or set aside what is not committed first: ${changed.join(', ')}`);
  const stack = await devStackProblem(REPO);
  if (stack) throw new Error(stack);

  const commit = git(REPO, ['rev-parse', 'HEAD']);
  const shipped = shippedThrough(pushedGates(REPO, commit));
  if (!shipped) throw new Error(`${commit.slice(0, 12)} has not shipped; run \`npm run ship\` first`);
  git(REPO, ['fetch', '-q', 'origin', 'main']);
  try { git(REPO, ['merge-base', '--is-ancestor', commit, 'origin/main']); } catch { throw new Error(`origin/main does not have ${commit.slice(0, 12)}; run \`npm run ship\` to push it`); }

  const tags = git(REPO, ['tag', '--list', 'v*']).split('\n').filter(Boolean);
  const version = named ?? nextVersion(new Date().toISOString(), tags);
  if (tags.includes(version)) throw new Error(`${version} already exists`);
  if (!/^v\d{4}\.\d{2}\.\d{2}(-\d+)?$/.test(version)) throw new Error(`${version} is not v<year>.<month>.<day>[-<n>]`);
  const previous = git(REPO, ['describe', '--tags', '--abbrev=0', '--match', 'v*', commit]);

  const record = readRecord(REPO, commit) ?? { commit };
  if (record.released) throw new Error(`${commit.slice(0, 12)} was already released as ${record.released.version}`);

  console.log(`release ${version} from ${commit.slice(0, 12)}, after ${previous}: the VM suites and the rehearsal, about three hours. Leave this checkout as it is until it ends; work elsewhere.`);
  const started = Date.now();
  const image = buildAppImage(REPO, commit, (line) => console.log(`  ${line}`));
  execFileSync('docker', ['tag', image, 'nowrinkles/app:dev']);
  console.log(`  ${image} is nowrinkles/app:dev for the VM suites`);

  const steps = runSteps(REPO, commit, RELEASE_STEPS, {
    GROVE_LIVE_OWNER: admin,
    CHECKS_LIVE_OWNER: admin,
    INSTANCE_LIVE_OWNER: admin,
    RELEASE_LIVE_PREVIOUS: previous,
  });
  writeRecord(REPO, { ...record, shipped, released: { at: new Date().toISOString(), steps, version, previous } });
  git(REPO, ['tag', '-a', version, commit, '-m', `${version}\n\nShipped and released from ${commit.slice(0, 12)} after ${previous}: ${steps.map((step) => step.script.replace(/^test:/, '')).join(', ')}.`]);
  console.log(`\n✓ ${version} released: ${steps.length} steps in ${minutesSince(started)} min, tagged`);

  const ledger = commitLedger(REPO, `The live ledger records ${version} passing release`);
  if (!PUSH) {
    console.log(`not pushed (--no-push); push with: git push origin ${ledger ? 'main ' : ''}${version}`);
    return;
  }
  const pushed = spawnSync('git', ['push', 'origin', ...(ledger ? ['main'] : []), version], { cwd: REPO, stdio: 'inherit' });
  if (pushed.status !== 0) throw new Error('git push failed');
  console.log(`GitHub builds the image and chart for ${version} now (the Release workflow)`);
}

main().catch((err: Error) => {
  console.error(`\n✗ release: ${err.message}`);
  process.exit(1);
});
