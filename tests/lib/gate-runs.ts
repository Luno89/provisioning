import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { changedBesidesLedger, LEDGER_FILES, onlyLedger, RELEASE_SIGNERS, stepFailed, type GateRecord, type GateStep, type PushedGates, type StepPassed, productionVulnerabilities, type Vulnerability } from './gates.js';
import { imageTagOf } from './release-lab.js';
import { auditFileOf, auditRefusal, FAILURES_FILE, owedAudits, type Failures } from './audits.js';
import { DEV_OWNER_FILE, devKoalaCheckout, devOwnerSignIn, devRootApi } from './dev-stack.js';
import { DEV_UP_STEP, devStackProblemOf, devStackState, devStepOf, provisioningFailed, type DevStackLooks } from './dev-stack-state.js';
import { devFile } from './dev-temporal.js';
import { keepTimings, slowerThanUsual, timingsIn, TIMINGS_FILE } from './timings.js';
import { showGrowing } from './show-growing.js';
import { refuseWithoutRoom } from '../tiers/room.js';
import { watchQuiet } from './quiet-watch.js';

const gitOut = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const git = (repo: string, args: string[]): string => gitOut(repo, args).trim();

const gatesDir = (repo: string): string => join(resolve(repo, git(repo, ['rev-parse', '--git-common-dir'])), 'koala-gates');

export function timingsFileOf(repo: string): string {
  mkdirSync(gatesDir(repo), { recursive: true });
  return join(gatesDir(repo), TIMINGS_FILE);
}

const timingEnv = (repo: string, commit: string): Record<string, string> => ({ KOALA_GATE_TIMINGS: timingsFileOf(repo), KOALA_GATE_COMMIT: commit });

export function reportSlower(repo: string, commit: string): void {
  const slower = slowerThanUsual(timingsIn(timingsFileOf(repo)), commit);
  if (slower.length === 0) return;
  console.log(`\nslower than usual on ${commit.slice(0, 12)} (a guide, not a gate):`);
  for (const line of slower) console.log(`  ${line}`);
}

export function readRecord(repo: string, commit: string): GateRecord | undefined {
  const file = join(gatesDir(repo), `${commit}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GateRecord) : undefined;
}

export function writeRecord(repo: string, record: GateRecord): void {
  mkdirSync(gatesDir(repo), { recursive: true });
  writeFileSync(join(gatesDir(repo), `${record.commit}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export function codeCommitOf(repo: string, commit: string): string {
  let at = commit;
  for (;;) {
    let parent: string | undefined;
    try { parent = git(repo, ['rev-parse', '--verify', '--quiet', `${at}^`]); } catch { parent = undefined; }
    if (!parent) return at;
    if (!onlyLedger(git(repo, ['diff', '--name-only', parent, at]).split('\n').filter(Boolean))) return at;
    at = parent;
  }
}

export function pushedGates(repo: string, commit: string): PushedGates {
  const code = codeCommitOf(repo, commit);
  if (code !== commit) return { record: readRecord(repo, commit), parent: readRecord(repo, code), onlyLedgerSinceParent: true };
  let parent: string | undefined;
  try { parent = git(repo, ['rev-parse', '--verify', '--quiet', `${commit}^`]); } catch { parent = undefined; }
  return { record: readRecord(repo, commit), parent: parent ? readRecord(repo, parent) : undefined, onlyLedgerSinceParent: false };
}

export function ignoredIn(repo: string, commit: string): string[] {
  const paths = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', commit], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
  const checked = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], { cwd: repo, input: paths, maxBuffer: 256 * 1024 * 1024 });
  if (checked.status !== 0 && checked.status !== 1) throw new Error(`git check-ignore failed: ${checked.stderr.toString().trim()}`);
  return checked.stdout.toString().split('\0').filter(Boolean);
}

export function leaksIn(repo: string, range: string): string | undefined {
  const tool = ciTool(repo, 'gitleaks');
  const scan = spawnSync(tool, ['git', `--log-opts=${range}`, '--redact', '--no-banner', '--verbose', '--no-color', '--exit-code', '3', '.'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (scan.status === 0) return undefined;
  if (scan.status === 3) return scan.stdout.trim();
  throw new Error(`gitleaks could not scan ${range}: ${scan.stderr.trim()}`);
}

export function vulnerabilitiesIn(repo: string): Vulnerability[] {
  const tool = ciTool(repo, 'osv-scanner');
  const scan = spawnSync(tool, ['scan', 'source', '--lockfile=package-lock.json', '--config=osv-scanner.toml', '--format=json'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (scan.status !== 0 && scan.status !== 1) throw new Error(`osv-scanner could not scan package-lock.json: ${scan.stderr.trim()}`);
  return productionVulnerabilities(JSON.parse(scan.stdout));
}

export function npmPublishTimes(repo: string): (name: string, version: string) => string | undefined {
  const times = new Map<string, Record<string, string> | undefined>();
  return (name, version) => {
    if (!times.has(name)) {
      const view = spawnSync('npm', ['view', name, 'time', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      times.set(name, view.status === 0 ? JSON.parse(view.stdout) as Record<string, string> : undefined);
    }
    return times.get(name)?.[version];
  };
}

const VERIFY_RELEASE = new URL('../../scripts/root-node/verify-release.sh', import.meta.url).pathname;
const ciTool = (repo: string, tool: string): string =>
  execFileSync('bash', [new URL('../../scripts/ci-tools.sh', import.meta.url).pathname, tool], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

export const releaseKey = (): string => process.env.KOALA_RELEASE_KEY ?? join(homedir(), '.ssh', 'koala-release');

export const readIfThere = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

export function tagSignatureProblem(repo: string, tag: string): string | undefined {
  const checked = spawnSync('bash', [VERIFY_RELEASE, 'tag', repo, tag], { encoding: 'utf8', env: { ...process.env, RELEASE_SIGNERS: join(repo, RELEASE_SIGNERS) } });
  return checked.status === 0 ? undefined : checked.stderr.trim() || `verify-release.sh ended with ${checked.status}`;
}

export function signTag(repo: string, version: string, commit: string, message: string, key: string): void {
  const signed = spawnSync('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'tag', '-s', version, commit, '-m', message], { cwd: repo, stdio: 'inherit' });
  if (signed.status !== 0) throw new Error(`git could not sign ${version} with ${key}`);
}

export function githubSlug(repo: string): string {
  const origin = git(repo, ['remote', 'get-url', 'origin']);
  const slug = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(origin)?.[1];
  if (!slug) throw new Error(`origin (${origin}) is not on GitHub`);
  return slug;
}

export function releaseWorkflowFailure(slug: string, version: string): string | undefined {
  const listed = spawnSync('gh', ['run', 'list', '--repo', slug, '--workflow', 'release.yml', '--branch', version, '--limit', '1', '--json', 'status,conclusion,url'], { encoding: 'utf8' });
  if (listed.status !== 0) return undefined;
  const [latest] = JSON.parse(listed.stdout) as { status: string; conclusion: string; url: string }[];
  return latest && latest.status === 'completed' && latest.conclusion !== 'success' ? `the Release workflow for ${version} ended ${latest.conclusion}: ${latest.url}` : undefined;
}

export function waitForRelease(slug: string, version: string, log: (line: string) => void): void {
  const started = Date.now();
  let told = 0;
  for (;;) {
    const answered = spawnSync('curl', ['-fsS', '-o', '/dev/null', `https://api.github.com/repos/${slug}/releases/tags/${version}`], { stdio: 'ignore' });
    if (answered.status === 0) return;
    const failure = releaseWorkflowFailure(slug, version);
    if (failure) throw new Error(`GitHub will not have release ${version}: ${failure}`);
    const minutes = Math.floor((Date.now() - started) / 60_000);
    if (minutes >= told + 10) {
      told = minutes;
      log(`GitHub has no release ${version} yet after ${minutes} min; the Release workflow makes it last, after the image and its attestation`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
  }
}

export function verifyPublished(repo: string, version: string, commit: string): string {
  const checked = spawnSync('bash', [VERIFY_RELEASE, 'image', version, commit], {
    encoding: 'utf8',
    env: { ...process.env, COSIGN: ciTool(repo, 'cosign'), PUBLISHED_IMAGE: publishedImageOf(repo), RELEASE_REPO: githubSlug(repo) },
  });
  if (checked.status !== 0) throw new Error(checked.stderr.trim() || `verify-release.sh ended with ${checked.status}`);
  return checked.stdout.trim();
}

export const changedNow = (repo: string): string[] => changedBesidesLedger(gitOut(repo, ['status', '--porcelain']));

function servingFrom(port: string): string | undefined {
  const listening = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  const pid = /pid=(\d+)/.exec(listening)?.[1];
  if (!pid) return undefined;
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
}

const devStackLooks = (): DevStackLooks => ({
  rootApi: devRootApi,
  rootFrom: () => servingFrom(new URL(devRootApi).port),
  koalaFrom: devKoalaCheckout,
  ownerSignIn: () => (existsSync(devFile(DEV_OWNER_FILE)) ? devOwnerSignIn() : undefined),
});

export async function devStackProblem(repo: string): Promise<string | undefined> {
  return devStackProblemOf(await devStackState(repo, devStackLooks()));
}

export const DEV_STACK_LOG = 'tests/.dev-stack.log';

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function freshDevStack(repo: string): Promise<void> {
  console.log('\n━━ a fresh dev stack: reset, set up from this checkout, then npm run dev, which asks you here before the join installs anything');
  for (const script of ['dev:reset', 'setup']) {
    console.log(`\n━━ provisioning the dev stack: npm run ${script}`);
    const done = spawnSync('npm', ['run', script], { cwd: repo, stdio: 'inherit' });
    if (done.status !== 0) throw new Error(provisioningFailed(`npm run ${script} failed (${done.status ?? done.signal})`, {}));
  }
  console.log('\n━━ provisioning the dev stack: npm run dev, until root reports your Koala ready');
  const log = join(repo, DEV_STACK_LOG);
  const out = openSync(log, 'w');
  const dev = spawn('npm', ['run', 'dev'], { cwd: repo, stdio: ['ignore', out, out] });
  let stopped: string | undefined;
  dev.on('exit', (code, signal) => { stopped = `npm run dev stopped (${signal ?? code})`; });
  dev.unref();
  const shown = showGrowing(log, (text) => process.stdout.write(text));
  try {
    let told = '';
    for (;;) {
      const state = await devStackState(repo, devStackLooks());
      const devStep = devStepOf(readFileSync(log, 'utf8'));
      const said = state.kind === 'provisioning' ? state.stage : state.kind;
      if (said !== told) console.log(`  ship: ${state.kind === 'provisioning' ? state.stage : `the dev stack is ${state.kind}`}`);
      told = said;
      if (state.kind === 'ready' && devStep?.replace(/^\[\d+\] /, '').startsWith(DEV_UP_STEP)) break;
      if (stopped) throw new Error(provisioningFailed(stopped, { devStep, root: state }));
      if (state.kind === 'failed') throw new Error(provisioningFailed(state.stage, { devStep }));
      if (state.kind === 'not this checkout') throw new Error(provisioningFailed(state.why, { devStep }));
      await pause(2000);
    }
  } finally {
    shown.stop();
  }
  console.log(`\n━━ ✓ the dev stack is fresh: root reports your Koala ready, running this checkout; npm run dev runs on after ship, its output in ${DEV_STACK_LOG}`);
}

export function checkoutProblem(repo: string, commit: string): string | undefined {
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (head !== commit) return `the checkout moved from ${commit.slice(0, 12)} to ${head.slice(0, 12)}`;
  const changed = changedNow(repo);
  if (changed.length > 0) return `the checkout has changes the commit does not: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', …' : ''}`;
  return undefined;
}

export const minutesSince = (started: number): number => Math.round((Date.now() - started) / 6000) / 10;

const LIVE_SCRIPT = resolve(import.meta.dirname, '..', 'coupling', 'live.ts');
function failuresIn(repo: string): Failures {
  const file = join(repo, FAILURES_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Failures : {};
}

export function auditsOwed(repo: string): string | undefined {
  return auditRefusal(owedAudits(failuresIn(repo), (name) => git(repo, ['log', '-1', '--format=%cI', '--', auditFileOf(name)]).trim() || undefined));
}

export interface StepHooks {
  onPass?: (passed: StepPassed) => void;
  envFor?: (step: GateStep) => Record<string, string>;
  onEnd?: (step: GateStep) => void;
}

export function runSteps(repo: string, commit: string, steps: GateStep[], env: Record<string, string>, hooks: StepHooks = {}): StepPassed[] {
  const owed = auditsOwed(repo);
  if (owed) throw new Error(owed);
  refuseWithoutRoom(repo);
  const passed: StepPassed[] = [];
  steps.forEach((step, index) => {
    console.log(`\n━━ ${index + 1}/${steps.length} ${step.name} (npm run ${step.script})`);
    const started = Date.now();
    const watch = watchQuiet();
    let result;
    try {
      result = spawnSync('npm', ['run', step.script, '--silent'], { cwd: repo, stdio: 'inherit', env: { ...process.env, ...env, ...(hooks.envFor?.(step) ?? {}), ...timingEnv(repo, commit), KOALA_GATE_FAILURES: join(repo, FAILURES_FILE), ...watch.env } });
    } finally {
      watch.stop();
    }
    hooks.onEnd?.(step);
    const minutes = minutesSince(started);
    if (result.status !== 0) throw new Error(stepFailed(step, minutes));
    const moved = checkoutProblem(repo, commit);
    if (moved) throw new Error(`${moved} while ${step.name} ran, so what it tested is not this commit; run it again once the checkout is back`);
    console.log(`━━ ✓ ${step.name} in ${minutes} min`);
    keepTimings(timingsFileOf(repo), [{ at: new Date().toISOString(), commit, kind: 'step', name: step.script, seconds: (Date.now() - started) / 1000 }]);
    const kept = { name: step.name, script: step.script, minutes };
    passed.push(kept);
    hooks.onPass?.(kept);
  });
  return passed;
}

export interface RoundResult { step: GateStep; passed: boolean; minutes: number; seconds: number; log: string }

const clock = () => new Date().toISOString().slice(11, 19);

function runLogged(repo: string, commit: string, step: GateStep, env: Record<string, string>, logFile: string): Promise<RoundResult> {
  return new Promise((done) => {
    const started = Date.now();
    const log = createWriteStream(logFile);
    const child = spawn('npm', ['run', step.script, '--silent'], { cwd: repo, env: { ...process.env, ...env, ...timingEnv(repo, commit), KOALA_GATE_FAILURES: join(repo, FAILURES_FILE) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const write = (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line) log.write(`${clock()} ${line}\n`); };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.on('close', (code) => {
      log.end();
      done({ step, passed: code === 0, minutes: minutesSince(started), seconds: (Date.now() - started) / 1000, log: logFile });
    });
  });
}

export async function runRounds(repo: string, commit: string, rounds: readonly GateStep[][], env: Record<string, string>): Promise<RoundResult[]> {
  const owed = auditsOwed(repo);
  if (owed) throw new Error(owed);
  refuseWithoutRoom(repo, Math.max(1, ...rounds.map((round) => round.length)));
  const logs = join(repo, 'tests/.vm-logs');
  mkdirSync(logs, { recursive: true });
  const results: RoundResult[] = [];
  for (const [index, round] of rounds.entries()) {
    console.log(`\n━━ round ${index + 1}/${rounds.length}: ${round.map((step) => step.name).join(' · ')}`);
    const finished = await Promise.all(round.map((step) => runLogged(repo, commit, step, env, join(logs, `${step.script.replace(/[:/]/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`))));
    for (const result of finished) console.log(`━━ ${result.passed ? '✓' : '✗'} ${result.step.name} in ${result.minutes} min${result.passed ? '' : ` (${result.log})`}`);
    results.push(...finished);
    keepTimings(timingsFileOf(repo), finished.filter((result) => result.passed).map((result) => ({ at: new Date().toISOString(), commit, kind: 'step' as const, name: result.step.script, seconds: result.seconds })));
    const moved = checkoutProblem(repo, commit);
    if (moved) throw new Error(`${moved} while round ${index + 1} ran, so what it tested is not this commit; run it again once the checkout is back`);
  }
  return results;
}

export function commitLedger(repo: string, message: string): boolean {
  const status = git(repo, ['status', '--porcelain', '--', ...LEDGER_FILES]);
  if (!status) return false;
  git(repo, ['add', '--', ...LEDGER_FILES]);
  git(repo, ['commit', '-q', '-m', message, '--', ...LEDGER_FILES]);
  return true;
}

export function buildAppImage(repo: string, commit: string, log: (line: string) => void): string {
  const image = `nowrinkles/app:${imageTagOf(commit)}`;
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    log(`${image} is already built`);
    return image;
  } catch { /* not yet */ }
  const started = Date.now();
  const context = mkdtempSync(join(tmpdir(), `app-image-${imageTagOf(commit)}-`));
  try {
    execFileSync('sh', ['-c', `git -C "${repo}" archive "${commit}" | tar -x -C "${context}"`], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('bash', [join(repo, 'scripts/root-node/cdktf-bindings.sh'), context], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, TERRAFORM: join(repo, 'bin/terraform'), CDKTF: join(repo, 'node_modules/.bin/cdktf') },
    });
    execFileSync('docker', ['build', '-q', '--build-arg', 'BUILDKIT_INLINE_CACHE=1', '-t', image, context], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, DOCKER_BUILDKIT: '1' } });
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  log(`built ${image} in ${minutesSince(started)} min`);
  return image;
}

export function publishedImageOf(repo: string): string {
  const origin = git(repo, ['remote', 'get-url', 'origin']);
  const owner = /github\.com[:/]([^/]+)\//.exec(origin)?.[1];
  if (!owner) throw new Error(`origin (${origin}) is not on GitHub, so no image is published for it`);
  return `ghcr.io/${owner.toLowerCase()}/nowrinkles/app`;
}

export function updateRoot(target: string, version: string, repoDir: string): boolean {
  return spawnSync('ssh', ['-o', 'BatchMode=yes', target, 'sudo', 'bash', `${repoDir}/scripts/root-node/release-watch.sh`, version], { stdio: 'inherit', env: { ...process.env } }).status === 0;
}
