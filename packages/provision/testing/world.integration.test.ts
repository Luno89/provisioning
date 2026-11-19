import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localCommands } from '../src/local-commands.js';
import { removeSteps, runSteps } from '../src/steps.js';
import { waitUntil } from '../src/wait-until.js';
import { memoryReporter } from './memory-reporter.js';
import { leftoversStep, RUN_VARIABLE, runEnv, runFolder, runFolderStep, runOf, type TestRun } from './world.js';

const children: ChildProcess[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const ctx = { commands: localCommands(process.env) };

async function made(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

function sleeper(env: Record<string, string> = {}, cwd?: string, argv0?: string): ChildProcess {
  const { [RUN_VARIABLE]: _outer, ...outside } = process.env;
  const child = spawn('sleep', ['infinity'], { env: { ...outside, ...env }, stdio: 'ignore', ...(cwd ? { cwd } : {}), ...(argv0 ? { argv0 } : {}) });
  children.push(child);
  return child;
}

const ended = (child: ChildProcess): Promise<void> => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((done) => child.once('exit', () => done())));

async function runningIn(root: string, checkout: string): Promise<{ run: TestRun; maker: ChildProcess; worker: ChildProcess }> {
  const maker = sleeper();
  const run = await runOf(maker.pid!, root, checkout);
  await runSteps([runFolderStep(run)], ctx, memoryReporter());
  await writeFile(join(runFolder(run), 'mongo-data'), 'written by the run');
  return { run, maker, worker: sleeper(runEnv(run)) };
}

async function world(): Promise<{ root: string; checkout: string; ours: TestRun }> {
  const root = await made('koala-tests-root-');
  const checkout = await made('koala-checkout-');
  return { root, checkout, ours: await runOf(process.pid, root, checkout) };
}

const sweep = async (run: TestRun) => {
  const reporter = memoryReporter();
  await runSteps([leftoversStep(run)], ctx, reporter);
  return reporter.linesOf('leftovers');
};

describe('a test run owns its folder', () => {
  it('makes it under the root, its checkout and its pid, and its removal takes it away', async () => {
    const { ours } = await world();
    await runSteps([runFolderStep(ours)], ctx, memoryReporter());
    expect(runFolder(ours).startsWith(join(ours.root))).toBe(true);
    expect(runFolder(ours).endsWith(`/${process.pid}`)).toBe(true);
    expect(existsSync(runFolder(ours))).toBe(true);
    await removeSteps([runFolderStep(ours)], ctx, memoryReporter());
    expect(existsSync(runFolder(ours))).toBe(false);
  });
});

describe('the leftovers of this checkout\'s gone runs', () => {
  it('are removed when the run that made them was killed: its folder and the processes it started, each named', async () => {
    const { root, checkout, ours } = await world();
    const killed = await runningIn(root, checkout);
    killed.maker.kill('SIGKILL');
    await ended(killed.maker);
    const said = await sweep(ours);
    await ended(killed.worker);
    expect(existsSync(runFolder(killed.run))).toBe(false);
    expect(killed.worker.signalCode).toBe('SIGKILL');
    expect(said).toEqual(expect.arrayContaining([`removed the folder of gone test run ${killed.run.pid}: ${runFolder(killed.run)}`, `stopped process ${killed.worker.pid} (sleep infinity), left by gone test run ${killed.run.pid}`]));
  });

  it('leave a run that is still going alone, its folder and its processes', async () => {
    const { root, checkout, ours } = await world();
    const busy = await runningIn(root, checkout);
    expect(await sweep(ours)).toEqual([]);
    expect(existsSync(join(runFolder(busy.run), 'mongo-data'))).toBe(true);
    expect(busy.worker.exitCode === null && busy.worker.signalCode === null).toBe(true);
  });

  it('take a folder whose pid now belongs to another process as gone', async () => {
    const { root, checkout, ours } = await world();
    const reused = sleeper();
    const run = { ...(await runOf(reused.pid!, root, checkout)), started: 'an earlier start' };
    await runSteps([runFolderStep(run)], ctx, memoryReporter());
    await sweep(ours);
    expect(existsSync(runFolder(run))).toBe(false);
  });

  it('leave another checkout\'s gone run to that checkout, and remove the runs of a checkout that is gone', async () => {
    const { root, checkout, ours } = await world();
    const other = await made('koala-checkout-other-');
    const deleted = await made('koala-checkout-deleted-');
    const theirs = await runningIn(root, other);
    const orphaned = await runningIn(root, deleted);
    for (const gone of [theirs, orphaned]) { gone.maker.kill('SIGKILL'); await ended(gone.maker); }
    await rm(deleted, { recursive: true });
    await sweep(ours);
    await ended(orphaned.worker);
    expect(existsSync(runFolder(theirs.run))).toBe(true);
    expect(theirs.worker.exitCode === null && theirs.worker.signalCode === null).toBe(true);
    expect(existsSync(runFolder(orphaned.run))).toBe(false);
    expect(orphaned.worker.signalCode).toBe('SIGKILL');
    expect(checkout).not.toBe(other);
  });

  it('stop a test process whose worktree was deleted under it', async () => {
    const { ours } = await world();
    const worktree = await made('koala-worktree-');
    await mkdir(join(worktree, 'apps'));
    const stranded = sleeper({}, join(worktree, 'apps'), 'node vitest');
    await waitUntil('the stranded process to run as vitest', async () => (await readFile(`/proc/${stranded.pid}/cmdline`, 'utf8')).includes('vitest'));
    await rm(worktree, { recursive: true });
    const said = await sweep(ours);
    await ended(stranded);
    expect(stranded.signalCode).toBe('SIGKILL');
    expect(said.some((line) => line.startsWith(`stopped process ${stranded.pid} (node vitest infinity), whose worktree ${join(worktree, 'apps')} is gone`))).toBe(true);
  });
});
