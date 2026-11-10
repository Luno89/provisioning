import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { CHECKS_STEP, HOTFIX, HOTFIX_STEPS, SHIP_STEPS, checkedThrough, checksToRun, shipRun, shortName, stillToRun, ignoredRefusal, judgeVulnerabilities, leaksRefusal, shippedThrough, takeNowLines, waitingLines } from './lib/gates.js';
import { e2eEnv, shipChecks } from './lib/e2e-env.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
const NAMED_CHECKS = stepAt >= 0 ? process.argv.slice(stepAt + 2).flatMap((arg) => arg.split(',')).filter(Boolean) : [];

async function main(): Promise<void> {
  if (stepAt >= 0 && (!ONLY || HOTFIXING)) throw new Error(`name one step to run: ${SHIP_STEPS.map((step) => shortName(step.script)).join(', ')}`);
  const branch = git(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error(`ship runs on main, and this checkout is on ${branch}`);
  const changed = changedNow(REPO);
  if (changed.length > 0) throw new Error(`commit or set aside what is not committed first: ${changed.join(', ')}`);
  const ignored = ignoredRefusal(ignoredIn(REPO, 'HEAD'));
  if (ignored) throw new Error(`main ${ignored}`);
  const leaks = leaksRefusal(leaksIn(REPO, 'origin/main..HEAD'));
  if (leaks) throw new Error(`main: ${leaks}`);
  const advisories = judgeVulnerabilities(vulnerabilitiesIn(REPO), npmPublishTimes(REPO), new Date());
  for (const line of takeNowLines(advisories.due)) console.log(`to take now: ${line}`);
  for (const line of waitingLines(advisories.waiting)) console.log(`waiting: ${line}`);
  const stack = HOTFIXING ? undefined : await devStackProblem(REPO);
  if (stack) throw new Error(stack);
  const drifting = HOTFIXING ? undefined : gateRefusal(gateOf((await currentDrift(REPO)).findings, ANSWERS));
  if (drifting) throw new Error(drifting);
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
    const checksFile = join(REPO, 'tests', '.gate-checks.json');
    const checksBefore = codeRecord.checks ?? [];
    let checksKept = [...checksBefore];
    const checksNow = checksToRun(shipChecks(), checksBefore, NAMED_CHECKS);
    if ('refused' in checksNow) throw new Error(checksNow.refused);
    if (NAMED_CHECKS.length > 0 && shortName(ONLY ?? '') !== shortName(CHECKS_STEP)) throw new Error(`only ${shortName(CHECKS_STEP)} takes checks to run`);
    const checksStep = run.steps.find((step) => step.script === CHECKS_STEP);
    if (checksStep && checksNow.checks.length === 0) {
      console.log(`every mechanics check already passed on this commit: ${checksStep.name}`);
      run.steps.splice(run.steps.indexOf(checksStep), 1);
      kept = [...kept, { name: checksStep.name, script: CHECKS_STEP, minutes: 0 }];
      writeRecord(REPO, { ...codeRecord, checked: kept, checks: checksKept });
    } else if (checksStep) {
      console.log(`mechanics checks to run: ${checksNow.checks.length}, ${checksBefore.length} of ${shipChecks().length} passed on this commit already`);
    }
    const keepChecks = (): void => {
      if (!existsSync(checksFile)) return;
      const passed = JSON.parse(readFileSync(checksFile, 'utf8')) as string[];
      rmSync(checksFile);
      checksKept = [...new Set([...checksKept, ...passed])];
      writeRecord(REPO, { ...codeRecord, checked: kept, checks: checksKept });
      console.log(`mechanics checks passed on this commit: ${checksKept.length} of ${shipChecks().length}`);
    };
    runSteps(REPO, commit, run.steps, e2eEnv(owner!), {
      envFor: (step) => step.script === CHECKS_STEP ? { CHECKS_LIVE_SCENARIOS: checksNow.checks.join(','), KOALA_GATE_CHECKS: checksFile } : {},
      onEnd: (step) => { if (step.script === CHECKS_STEP) keepChecks(); },
      onPass: (passed) => {
        if (passed.script === CHECKS_STEP && shipChecks().some((check) => !checksKept.includes(check))) return;
        kept = [...kept.filter((step) => step.script !== passed.script), passed];
        writeRecord(REPO, { ...codeRecord, checked: kept, checks: checksKept });
      },
    });
    const left = stillToRun(SHIP_STEPS, kept);
    if (left.length > 0) {
      console.log(`\n✓ ${run.steps.map((step) => shortName(step.script)).join(', ')} passed on ${commit.slice(0, 12)} in ${minutesSince(started)} min; ship still needs ${left.map((step) => shortName(step.script)).join(', ')}`);
      if (commitLedger(REPO, `The live ledger records ${commit.slice(0, 12)} passing ${run.steps.map((step) => shortName(step.script)).join(', ')}`)) console.log('the live ledger is committed on top');
      return;
    }
    const steps = SHIP_STEPS.map((step) => kept.find((passed) => passed.script === step.script)!);
    writeRecord(REPO, { ...codeRecord, checked: kept, checks: checksKept, shipped: { at: new Date().toISOString(), steps } });
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
