import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { changedBesidesLedger, LEDGER_FILES, onlyLedger, type GateRecord, type GateStep, type PushedGates, type StepPassed } from './gates.js';
import { imageTagOf } from './release-lab.js';

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
  const tool = execFileSync('bash', [new URL('../../scripts/ci-tools.sh', import.meta.url).pathname, 'gitleaks'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const scan = spawnSync(tool, ['git', `--log-opts=${range}`, '--redact', '--no-banner', '--verbose', '--no-color', '--exit-code', '3', '.'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (scan.status === 0) return undefined;
  if (scan.status === 3) return scan.stdout.trim();
  throw new Error(`gitleaks could not scan ${range}: ${scan.stderr.trim()}`);
}

export const changedNow = (repo: string): string[] => changedBesidesLedger(gitOut(repo, ['status', '--porcelain']));

function servingFrom(): string | undefined {
  const listening = execFileSync('ss', ['-ltnpH', 'sport = :3001'], { encoding: 'utf8' });
  const pid = /pid=(\d+)/.exec(listening)?.[1];
  if (!pid) return undefined;
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
}

export async function devStackProblem(repo: string): Promise<string | undefined> {
  const answered = await fetch('http://localhost:3001/api/auth/me').then((res) => res.status, () => 0);
  if (answered !== 401) return 'the dev stack does not answer on :3001; start it with `npm run dev` from this checkout';
  const cwd = servingFrom();
  if (!cwd) return 'cannot tell which checkout the backend on :3001 runs from';
  if (cwd !== repo && !cwd.startsWith(`${repo}/`)) return `the backend on :3001 runs from ${cwd}, not this checkout (${repo}), so it is not running this commit`;
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

export function runSteps(repo: string, commit: string, steps: GateStep[], env: Record<string, string>): StepPassed[] {
  const passed: StepPassed[] = [];
  steps.forEach((step, index) => {
    console.log(`\n━━ ${index + 1}/${steps.length} ${step.name} (npm run ${step.script})`);
    const started = Date.now();
    const result = spawnSync('npm', ['run', step.script, '--silent'], { cwd: repo, stdio: 'inherit', env: { ...process.env, ...env } });
    const minutes = minutesSince(started);
    if (result.status !== 0) throw new Error(`${step.name} failed after ${minutes} min (npm run ${step.script})`);
    const moved = checkoutProblem(repo, commit);
    if (moved) throw new Error(`${moved} while ${step.name} ran, so what it tested is not this commit; run it again once the checkout is back`);
    console.log(`━━ ✓ ${step.name} in ${minutes} min`);
    passed.push({ name: step.name, script: step.script, minutes });
  });
  return passed;
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
