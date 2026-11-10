import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { HOTFIX, HOTFIX_STEPS, SHIP_STEPS, checkedThrough, shipRun, shortName, stillToRun, ignoredRefusal, judgeVulnerabilities, leaksRefusal, shippedThrough, vulnerableRefusal, waitingLines } from './lib/gates.js';
import { entriesOf, measuringProblem } from './coupling/live.js';
import { e2eEnv } from './lib/e2e-env.js';
import { devOwner } from './lib/dev-stack.js';
import { ANSWERS } from './alignment/answers.js';
import { currentDrift } from './alignment/drift-run.js';
import { gateOf, gateRefusal } from './alignment/gate.js';
import { changedNow, codeCommitOf, commitLedger, devStackProblem, git, ignoredIn, leaksIn, minutesSince, npmPublishTimes, pushedGates, readRecord, runSteps, vulnerabilitiesIn, writeRecord } from './lib/gate-runs.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const PUSH = !process.argv.includes('--no-push');
const HOTFIXING = process.argv.includes(HOTFIX);
const stepAt = process.argv.indexOf('--step');
const ONLY = stepAt >= 0 ? process.argv[stepAt + 1] : undefined;

async function main(): Promise<void> {
  const branch = git(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error(`ship runs on main, and this checkout is on ${branch}`);
  const changed = changedNow(REPO);
  if (changed.length > 0) throw new Error(`commit or set aside what is not committed first: ${changed.join(', ')}`);
  const ignored = ignoredRefusal(ignoredIn(REPO, 'HEAD'));
  if (ignored) throw new Error(`main ${ignored}`);
  const leaks = leaksRefusal(leaksIn(REPO, 'origin/main..HEAD'));
  if (leaks) throw new Error(`main: ${leaks}`);
  const advisories = judgeVulnerabilities(vulnerabilitiesIn(REPO), npmPublishTimes(REPO), new Date());
  const vulnerable = vulnerableRefusal(advisories.due);
  if (vulnerable) throw new Error(`main: ${vulnerable}`);
  for (const line of waitingLines(advisories.waiting)) console.log(`waiting: ${line}`);
  const stack = HOTFIXING ? undefined : await devStackProblem(REPO);
  if (stack) throw new Error(stack);
  const measuring = HOTFIXING ? undefined : measuringProblem(entriesOf());
  if (measuring) throw new Error(measuring);
  const drifting = HOTFIXING ? undefined : gateRefusal(gateOf((await currentDrift(REPO)).findings, ANSWERS));
  if (drifting) throw new Error(drifting);
  if (stepAt >= 0 && (!ONLY || HOTFIXING)) throw new Error(`name one step to run: ${SHIP_STEPS.map((step) => shortName(step.script)).join(', ')}`);
  const owner = HOTFIXING ? undefined : (await devOwner()).id;

  const commit = git(REPO, ['rev-parse', 'HEAD']);
  const record = readRecord(REPO, commit) ?? { commit };
  const gates = pushedGates(REPO, commit);
  const already = ONLY ? undefined : shippedThrough(gates);
  if (already) {
    console.log(`${commit.slice(0, 12)} already shipped at ${already.at}`);
    if (!record.shipped) writeRecord(REPO, { ...record, shipped: already });
  } else if (HOTFIXING) {
    console.log(`ship ${commit.slice(0, 12)} as a hotfix: the typecheck only, no suites`);
    const started = Date.now();
    const steps = runSteps(REPO, commit, HOTFIX_STEPS, {});
    writeRecord(REPO, { ...record, shipped: { at: new Date().toISOString(), steps, hotfix: true } });
    console.log(`\n✓ ${commit.slice(0, 12)} shipped as a hotfix in ${minutesSince(started)} min`);
  } else {
    const checked = checkedThrough(gates);
    const run = shipRun(SHIP_STEPS, checked, ONLY);
    if ('refused' in run) throw new Error(run.refused);
    const passedBefore = SHIP_STEPS.filter((step) => !run.steps.includes(step)).map((step) => checked.find((passed) => passed.script === step.script)).filter((passed) => passed !== undefined);
    for (const passed of passedBefore) console.log(`already passed on this commit: ${passed.name}`);
    console.log(`${ONLY ? 'run' : 'ship'} ${commit.slice(0, 12)}: ${run.steps.length} of ${SHIP_STEPS.length} steps against the dev stack, which runs this checkout. Leave it as it is until this ends; work elsewhere.`);
    const started = Date.now();
    const code = codeCommitOf(REPO, commit);
    const codeRecord = readRecord(REPO, code) ?? { commit: code };
    let kept = [...passedBefore.filter((passed) => !run.steps.some((step) => step.script === passed.script))];
    runSteps(REPO, commit, run.steps, e2eEnv(owner!), (passed) => {
      kept = [...kept.filter((step) => step.script !== passed.script), passed];
      writeRecord(REPO, { ...codeRecord, checked: kept });
    });
    const left = stillToRun(SHIP_STEPS, kept);
    if (left.length > 0) {
      console.log(`\n✓ ${run.steps.map((step) => shortName(step.script)).join(', ')} passed on ${commit.slice(0, 12)} in ${minutesSince(started)} min; ship still needs ${left.map((step) => shortName(step.script)).join(', ')}`);
      if (commitLedger(REPO, `The live ledger records ${commit.slice(0, 12)} passing ${run.steps.map((step) => shortName(step.script)).join(', ')}`)) console.log('the live ledger is committed on top');
      return;
    }
    const steps = SHIP_STEPS.map((step) => kept.find((passed) => passed.script === step.script)!);
    writeRecord(REPO, { ...codeRecord, checked: kept, shipped: { at: new Date().toISOString(), steps } });
    console.log(`\n✓ ${commit.slice(0, 12)} shipped: ${steps.length} steps, ${run.steps.length} run now, in ${minutesSince(started)} min`);
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
