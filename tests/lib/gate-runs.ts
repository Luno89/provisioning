import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { changedBesidesLedger, LEDGER_FILES, onlyLedger, RELEASE_SIGNERS, type GateRecord, type GateStep, type PushedGates, type StepPassed, productionVulnerabilities, type Vulnerability } from './gates.js';
import { imageTagOf } from './release-lab.js';
import { convert, liveProcesses, recordLive } from '../coupling/live.js';
import { auditFileOf, auditRefusal, FAILURES_FILE, owedAudits, withFailure, type Failures } from './audits.js';
import { devKoalaApi, devKoalaCheckout, devRootApi } from './dev-stack.js';

const gitOut = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const git = (repo: string, args: string[]): string => gitOut(repo, args).trim();

const gatesDir = (repo: string): string => join(resolve(repo, git(repo, ['rev-parse', '--git-common-dir'])), 'koala-gates');

export function readRecord(repo: string, commit: string): GateRecord | undefined {
  const file = join(gatesDir(repo), `${commit}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GateRecord) : undefined;
}

export function writeRecord(repo: string, record: GateRecord): void {
  mkdirSync(gatesDir(repo), { recursive: true });
  writeFileSync(join(gatesDir(repo), `${record.commit}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export function pushedGates(repo: string, commit: string): PushedGates {
  let parent: string | undefined;
  try { parent = git(repo, ['rev-parse', '--verify', '--quiet', `${commit}^`]); } catch { parent = undefined; }
  const changed = parent ? git(repo, ['diff', '--name-only', parent, commit]).split('\n').filter(Boolean) : [];
  return { record: readRecord(repo, commit), parent: parent ? readRecord(repo, parent) : undefined, onlyLedgerSinceParent: onlyLedger(changed) };
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

export function waitForRelease(slug: string, version: string, log: (line: string) => void): void {
  const started = Date.now();
  let told = 0;
  for (;;) {
    const answered = spawnSync('curl', ['-fsS', '-o', '/dev/null', `https://api.github.com/repos/${slug}/releases/tags/${version}`], { stdio: 'ignore' });
    if (answered.status === 0) return;
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

export async function devStackProblem(repo: string): Promise<string | undefined> {
  const root = await fetch(`${devRootApi}/api/auth/me`).then((res) => res.status, () => 0);
  if (root !== 401) return `root does not answer on ${devRootApi}; start the dev stack with \`npm run dev\` from this checkout`;
  const rootFrom = servingFrom(new URL(devRootApi).port);
  if (!rootFrom) return `cannot tell which checkout root on ${devRootApi} runs from`;
  if (rootFrom !== repo && !rootFrom.startsWith(`${repo}/`)) return `root on ${devRootApi} runs from ${rootFrom}, not this checkout (${repo}), so it is not running this commit`;
  const koala = await fetch(`${devKoalaApi}/api/auth/sign-in`).then((res) => res.status, () => 0);
  if (koala !== 200) return `your Koala does not answer on ${devKoalaApi}; the dev stack puts it on this computer's k3s`;
  let koalaFrom: string;
  try { koalaFrom = devKoalaCheckout(); } catch (err) { return `cannot tell which checkout your Koala's pods run: ${(err as Error).message}`; }
  if (koalaFrom !== repo) return `your Koala's pods run ${koalaFrom || 'no checkout'}, not this checkout (${repo}), so they are not running this commit`;
  return undefined;
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
const liveLabelOf = (script: string): string => `tests/${script.replace(/^test:/, '')}.ts`;

function liveCoverage(repo: string, ...args: string[]): void {
  const done = spawnSync('npx', ['tsx', LIVE_SCRIPT, ...args], { cwd: repo, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`the dev stack's coverage could not be read (${args.join(' ')})`);
}

function failuresIn(repo: string): Failures {
  const file = join(repo, FAILURES_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Failures : {};
}

export function auditsOwed(repo: string): string | undefined {
  return auditRefusal(owedAudits(failuresIn(repo), (name) => git(repo, ['log', '-1', '--format=%cI', '--', auditFileOf(name)]).trim() || undefined));
}

function recordFailure(repo: string, name: string): void {
  writeFileSync(join(repo, FAILURES_FILE), `${JSON.stringify(withFailure(failuresIn(repo), name, new Date().toISOString()), null, 1)}\n`);
}

export function runSteps(repo: string, commit: string, steps: GateStep[], env: Record<string, string>): StepPassed[] {
  const owed = auditsOwed(repo);
  if (owed) throw new Error(owed);
  const passed: StepPassed[] = [];
  const measured = liveProcesses().length > 0;
  const sampled: string[] = [];
  let recorded = 0;
  const recordSampled = () => {
    if (sampled.length === recorded) return;
    console.log(`the dev stack's coverage: ${convert()} live suites`);
    recordLive(sampled);
    recorded = sampled.length;
  };
  steps.forEach((step, index) => {
    console.log(`\n━━ ${index + 1}/${steps.length} ${step.name} (npm run ${step.script})`);
    const started = Date.now();
    const live = measured && /-live$/.test(step.script);
    if (!live) recordSampled();
    if (live) liveCoverage(repo, 'discard');
    const result = spawnSync('npm', ['run', step.script, '--silent'], { cwd: repo, stdio: 'inherit', env: { ...process.env, ...env, KOALA_GATE_FAILURES: join(repo, FAILURES_FILE) } });
    if (result.status !== 0 && /-live$/.test(step.script)) recordFailure(repo, step.script);
    if (live) {
      liveCoverage(repo, 'sample', liveLabelOf(step.script));
      sampled.push(liveLabelOf(step.script));
    }
    const minutes = minutesSince(started);
    if (result.status !== 0) throw new Error(`${step.name} failed after ${minutes} min (npm run ${step.script})`);
    const moved = checkoutProblem(repo, commit);
    if (moved) throw new Error(`${moved} while ${step.name} ran, so what it tested is not this commit; run it again once the checkout is back`);
    console.log(`━━ ✓ ${step.name} in ${minutes} min`);
    passed.push({ name: step.name, script: step.script, minutes });
  });
  recordSampled();
  return passed;
}

export interface RoundResult { step: GateStep; passed: boolean; minutes: number; log: string }

const clock = () => new Date().toISOString().slice(11, 19);

function runLogged(repo: string, step: GateStep, env: Record<string, string>, logFile: string): Promise<RoundResult> {
  return new Promise((done) => {
    const started = Date.now();
    const log = createWriteStream(logFile);
    const child = spawn('npm', ['run', step.script, '--silent'], { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const write = (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line) log.write(`${clock()} ${line}\n`); };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.on('close', (code) => {
      log.end();
      done({ step, passed: code === 0, minutes: minutesSince(started), log: logFile });
    });
  });
}

export async function runRounds(repo: string, commit: string, rounds: readonly GateStep[][], env: Record<string, string>): Promise<RoundResult[]> {
  const logs = join(repo, 'tests/.vm-logs');
  mkdirSync(logs, { recursive: true });
  const results: RoundResult[] = [];
  for (const [index, round] of rounds.entries()) {
    console.log(`\n━━ round ${index + 1}/${rounds.length}: ${round.map((step) => step.name).join(' · ')}`);
    const finished = await Promise.all(round.map((step) => runLogged(repo, step, env, join(logs, `${step.script.replace(/[:/]/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`))));
    for (const result of finished) console.log(`━━ ${result.passed ? '✓' : '✗'} ${result.step.name} in ${result.minutes} min${result.passed ? '' : ` (${result.log})`}`);
    results.push(...finished);
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

export function waitForPublished(image: string, log: (line: string) => void): void {
  const started = Date.now();
  let told = 0;
  for (;;) {
    if (spawnSync('docker', ['manifest', 'inspect', image], { stdio: 'ignore' }).status === 0) return;
    const minutes = Math.floor((Date.now() - started) / 60_000);
    if (minutes >= told + 5) {
      told = minutes;
      log(`${image} is not published yet after ${minutes} min; the Release workflow builds it (and the package must be public for root to pull it)`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  }
}

export function updateRoot(target: string, version: string, repoDir: string): boolean {
  return spawnSync('ssh', ['-o', 'BatchMode=yes', target, 'sudo', 'bash', `${repoDir}/scripts/root-node/release-watch.sh`, version], { stdio: 'inherit', env: { ...process.env } }).status === 0;
}
