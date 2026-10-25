import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HOTFIX, HOTFIX_STEPS, nextVersion, RELEASE_SIGNERS, RELEASE_STEPS, shippedThrough, signingKeyProblem, tagMessage } from './lib/gates.js';
import { buildAppImage, changedNow, commitLedger, devStackProblem, git, githubSlug, minutesSince, pushedGates, readIfThere, readRecord, releaseKey, runSteps, signTag, tagSignatureProblem, updateRoot, verifyPublished, waitForRelease, writeRecord } from './lib/gate-runs.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const PUSH = !process.argv.includes('--no-push');
const HOTFIXING = process.argv.includes(HOTFIX);
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
  const shipped = shippedThrough(pushedGates(REPO, commit));
  if (!shipped) throw new Error(`${commit.slice(0, 12)} has not shipped; run \`npm run ship\` first`);
  git(REPO, ['fetch', '-q', 'origin', 'main']);
  try { git(REPO, ['merge-base', '--is-ancestor', commit, 'origin/main']); } catch { throw new Error(`origin/main does not have ${commit.slice(0, 12)}; run \`npm run ship\` to push it`); }

  const tags = git(REPO, ['tag', '--list', 'v*']).split('\n').filter(Boolean);
  const version = named ?? nextVersion(new Date().toISOString(), tags);
  if (tags.includes(version)) throw new Error(`${version} already exists`);
  if (!/^v\d{4}\.\d{2}\.\d{2}(-\d+)?$/.test(version)) throw new Error(`${version} is not v<year>.<month>.<day>[-<n>]`);
  const previous = git(REPO, ['describe', '--tags', '--abbrev=0', '--match', 'v*', commit]);

  const key = releaseKey();
  const keyProblem = signingKeyProblem(key, readIfThere(`${key}.pub`), readIfThere(join(REPO, RELEASE_SIGNERS)));
  if (keyProblem) throw new Error(keyProblem);

  const record = readRecord(REPO, commit) ?? { commit };
  if (record.released) throw new Error(`${commit.slice(0, 12)} was already released as ${record.released.version}`);

  console.log(HOTFIXING
    ? `hotfix ${version} from ${commit.slice(0, 12)}, after ${previous}: the image build and the typecheck only, no suites.`
    : `release ${version} from ${commit.slice(0, 12)}, after ${previous}: the VM suites and the rehearsal, about three hours. Leave this checkout as it is until it ends; work elsewhere.`);
  const started = Date.now();
  const image = buildAppImage(REPO, commit, (line) => console.log(`  ${line}`));
  if (!HOTFIXING) {
    execFileSync('docker', ['tag', image, 'nowrinkles/app:dev']);
    console.log(`  ${image} is nowrinkles/app:dev for the VM suites`);
  }

  const steps = runSteps(REPO, commit, HOTFIXING ? HOTFIX_STEPS : RELEASE_STEPS, HOTFIXING ? {} : {
    GROVE_LIVE_OWNER: admin ?? '',
    CHECKS_LIVE_OWNER: admin ?? '',
    INSTANCE_LIVE_OWNER: admin ?? '',
    RELEASE_LIVE_PREVIOUS: previous,
  });
  writeRecord(REPO, { ...record, shipped, released: { at: new Date().toISOString(), steps, version, previous, ...(HOTFIXING ? { hotfix: true as const } : {}) } });
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
