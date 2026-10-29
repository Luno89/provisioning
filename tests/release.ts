import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { checkedThrough, HOTFIX, HOTFIX_STEPS, nextVersion, RELEASE_SIGNERS, RELEASE_STEPS, roundsOf, shippedThrough, signingKeyProblem, stillToRun, tagMessage, type StepPassed } from './lib/gates.js';
import { availableMemoryMB } from './lib/vm-rounds.js';
import { buildAppImage, changedNow, commitLedger, devStackProblem, git, githubSlug, minutesSince, pushedGates, readIfThere, readRecord, releaseKey, runRounds, runSteps, signTag, tagSignatureProblem, updateRoot, verifyPublished, waitForRelease, writeRecord } from './lib/gate-runs.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const PUSH = !process.argv.includes('--no-push');
const HOTFIXING = process.argv.includes(HOTFIX);
const CHECKING = process.argv.includes('--check');
const named = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

async function main(): Promise<void> {
  const admin = process.env.MECHANICS_ADMIN;
  if (!admin && !HOTFIXING) throw new Error('set MECHANICS_ADMIN to the admin the suites act as');
  const branch = git(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error(`release runs on main, and this checkout is on ${branch}`);
  const changed = changedNow(REPO);
  if (changed.length > 0) throw new Error(`commit or set aside what is not committed first: ${changed.join(', ')}`);
  const stack = HOTFIXING ? undefined : await devStackProblem(REPO);
  if (stack) throw new Error(stack);

  const commit = git(REPO, ['rev-parse', 'HEAD']);
  const gates = pushedGates(REPO, commit);
  const record = readRecord(REPO, commit) ?? { commit };
  if (record.released) throw new Error(`${commit.slice(0, 12)} was already released as ${record.released.version}`);
  const previous = git(REPO, ['describe', '--tags', '--abbrev=0', '--match', 'v*', commit]);
  const env = {
    GROVE_LIVE_OWNER: admin ?? '',
    CHECKS_LIVE_OWNER: admin ?? '',
    INSTANCE_LIVE_OWNER: admin ?? '',
    ODOO_RELEASE_LIVE_OWNER: admin ?? '',
    RELEASE_LIVE_PREVIOUS: previous,
  };

  const runChecks = async (): Promise<{ checked: StepPassed[]; failed: string[] }> => {
    const already = checkedThrough(gates);
    const left = stillToRun(RELEASE_STEPS, already);
    if (already.length) console.log(`  already passed for ${commit.slice(0, 12)}: ${already.map((step) => step.script.replace(/^test:/, '')).join(', ')}`);
    if (left.length === 0) return { checked: already, failed: [] };
    const image = buildAppImage(REPO, commit, (line) => console.log(`  ${line}`));
    execFileSync('docker', ['tag', image, 'nowrinkles/app:dev']);
    console.log(`  ${image} is nowrinkles/app:dev for the VM suites`);
    const available = availableMemoryMB();
    const rounds = roundsOf(left, available);
    console.log(`  ${available} MB free: ${rounds.length} round${rounds.length === 1 ? '' : 's'}: ${rounds.map((round) => round.map((step) => step.script.replace(/^test:/, '')).join(' + ')).join(' → ')}`);
    const results = await runRounds(REPO, commit, rounds, env);
    const passed = results.filter((result) => result.passed).map((result) => ({ name: result.step.name, script: result.step.script, minutes: result.minutes }));
    const checked = [...already, ...passed];
    writeRecord(REPO, { ...record, checked });
    console.log('\n| Step | Result | Minutes |\n|---|---|---|');
    for (const step of RELEASE_STEPS) {
      const result = results.find((one) => one.step.script === step.script);
      console.log(`| ${step.name} | ${result ? (result.passed ? 'passed' : 'failed') : 'passed before'} | ${result?.minutes ?? '—'} |`);
    }
    return { checked, failed: results.filter((result) => !result.passed).map((result) => `${result.step.name} (${result.log})`) };
  };

  if (CHECKING) {
    console.log(`check ${commit.slice(0, 12)} against every release step, in rounds by free memory, carrying on past a failure; nothing is tagged.`);
    const started = Date.now();
    const { failed } = await runChecks();
    if (failed.length) throw new Error(`${failed.length} release step${failed.length === 1 ? '' : 's'} failed:\n  ${failed.join('\n  ')}`);
    console.log(`\n✓ every release step passed for ${commit.slice(0, 12)} in ${minutesSince(started)} min; \`npm run release\` on it (or a ledger commit on top) goes straight to signing`);
    return;
  }

  const shipped = shippedThrough(gates);
  if (!shipped) throw new Error(`${commit.slice(0, 12)} has not shipped; run \`npm run ship\` first`);
  git(REPO, ['fetch', '-q', 'origin', 'main']);
  try { git(REPO, ['merge-base', '--is-ancestor', commit, 'origin/main']); } catch { throw new Error(`origin/main does not have ${commit.slice(0, 12)}; run \`npm run ship\` to push it`); }

  const tags = git(REPO, ['tag', '--list', 'v*']).split('\n').filter(Boolean);
  const version = named ?? nextVersion(new Date().toISOString(), tags);
  if (tags.includes(version)) throw new Error(`${version} already exists`);
  if (!/^v\d{4}\.\d{2}\.\d{2}(-\d+)?$/.test(version)) throw new Error(`${version} is not v<year>.<month>.<day>[-<n>]`);

  const key = releaseKey();
  const keyProblem = signingKeyProblem(key, readIfThere(`${key}.pub`), readIfThere(join(REPO, RELEASE_SIGNERS)));
  if (keyProblem) throw new Error(keyProblem);

  console.log(HOTFIXING
    ? `hotfix ${version} from ${commit.slice(0, 12)}, after ${previous}: the image build and the typecheck only, no suites.`
    : `release ${version} from ${commit.slice(0, 12)}, after ${previous}: every release step not yet passed for this commit, in rounds by free memory. Leave this checkout as it is until it ends; work elsewhere.`);
  const started = Date.now();
  let steps: StepPassed[];
  if (HOTFIXING) {
    buildAppImage(REPO, commit, (line) => console.log(`  ${line}`));
    steps = runSteps(REPO, commit, HOTFIX_STEPS, {});
  } else {
    const { checked, failed } = await runChecks();
    if (failed.length) throw new Error(`${failed.length} release step${failed.length === 1 ? '' : 's'} failed, so nothing is tagged; the ones that passed are kept for this commit:\n  ${failed.join('\n  ')}`);
    buildAppImage(REPO, commit, (line) => console.log(`  ${line}`));
    steps = RELEASE_STEPS.map((step) => checked.find((passed) => passed.script === step.script)!);
  }
  writeRecord(REPO, { ...(readRecord(REPO, commit) ?? record), shipped, released: { at: new Date().toISOString(), steps, version, previous, ...(HOTFIXING ? { hotfix: true as const } : {}) } });
  console.log(`\nsigning ${version} with ${key}`);
  signTag(REPO, version, commit, tagMessage(version, commit, previous, steps, HOTFIXING), key);
  const unsigned = tagSignatureProblem(REPO, version);
  if (unsigned) throw new Error(`${version} was tagged but does not verify: ${unsigned}`);
  console.log(`✓ ${version} ${HOTFIXING ? 'tagged as a hotfix' : 'released'}: ${steps.length} steps in ${minutesSince(started)} min, tagged and signed`);

  const ledger = HOTFIXING ? false : commitLedger(REPO, `The live ledger records ${version} passing release`);
  if (!PUSH) {
    console.log(`not pushed (--no-push); push with: git push origin ${ledger ? 'main ' : ''}${version}`);
    return;
  }
  const pushed = spawnSync('git', ['push', 'origin', ...(ledger ? ['main'] : []), version], { cwd: REPO, stdio: 'inherit' });
  if (pushed.status !== 0) throw new Error('git push failed');
  console.log(`GitHub builds, attests and publishes the image and chart for ${version} now (the Release workflow); waiting for it`);
  waitForRelease(githubSlug(REPO), version, (line) => console.log(`  ${line}`));
  const digest = verifyPublished(REPO, version, commit);
  console.log(`✓ ${digest} is attested as built by release.yml from ${commit.slice(0, 12)} at ${version}, the check root makes before it moves`);

  const root = process.env.ROOT_SSH;
  if (!root) {
    console.log('root moves onto it at its next hourly look (set ROOT_SSH=<user@host> to move it now)');
    return;
  }
  console.log(`updating root (${root})`);
  if (!updateRoot(root, version, process.env.ROOT_REPO_DIR ?? '/opt/nowrinkles')) throw new Error(`root did not move onto ${version}; it tries again at its next hourly look, or run scripts/root-node/release-watch.sh ${version} there`);
  console.log(`root runs ${version}; instances on automatic updates follow at their next check-in`);
}

main().catch((err: Error) => {
  console.error(`\n✗ release: ${err.message}`);
  process.exit(1);
});
