import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { removeThrowaway, throwawayOrphans } from '@koala/engine-core/testing/throwaway-containers';
import type { CommandRunner } from '../src/commands.js';
import type { Progress, Step } from '../src/steps.js';
import { waiting, waitUntil } from '../src/wait-until.js';

export const RUN_VARIABLE = 'KOALA_TEST_RUN';
export const TESTS_FOLDER = 'koala-tests';
const RECORD = '.run';
const CHECKOUT_FILE = 'checkout';
const DELETED = ' (deleted)';

export interface TestRun {
  root: string;
  checkout: string;
  pid: number;
  started: string;
}

export interface WorldContext {
  commands: CommandRunner;
}

interface Leftover {
  said: string;
  remove(progress: Progress): Promise<void>;
}

const checkoutKey = (checkout: string): string => createHash('sha256').update(checkout).digest('hex').slice(0, 12);
const checkoutFolder = (root: string, checkout: string): string => join(root, checkoutKey(checkout));
export const runFolder = (run: TestRun): string => join(checkoutFolder(run.root, run.checkout), String(run.pid));
export const runEnv = (run: TestRun): Record<string, string> => ({ [RUN_VARIABLE]: `${run.pid}:${run.started}:${run.checkout}` });

const gone = (err: unknown): boolean => ['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code ?? '');
const notOurs = (err: unknown): boolean => gone(err) || (err as NodeJS.ErrnoException).code === 'EACCES';

async function readOr<T>(read: () => Promise<T>, unreadable: (err: unknown) => boolean): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (unreadable(err)) return undefined;
    throw err;
  }
}

interface Stat { state: string; parent: number; started: string }

async function statOf(pid: number): Promise<Stat | undefined> {
  const text = await readOr(() => readFile(`/proc/${pid}/stat`, 'utf8'), gone);
  if (text === undefined) return undefined;
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { state: fields[0] ?? '', parent: Number(fields[1]), started: fields[19] ?? '' };
}

async function alive(pid: number, started?: string): Promise<boolean> {
  const stat = await statOf(pid);
  if (!stat || stat.state === 'Z') return false;
  return started === undefined || stat.started === started;
}

export async function runOf(pid: number, root: string, checkout: string): Promise<TestRun> {
  const stat = await statOf(pid);
  if (!stat) throw new Error(`process ${pid} is not running, so it cannot own a test run`);
  return { root, checkout, pid, started: stat.started };
}

export function runFolderStep(run: TestRun): Step<WorldContext> {
  const folder = runFolder(run);
  return {
    id: 'run-folder',
    title: `This test run's folder, ${folder}`,
    check: async () => (existsSync(join(folder, RECORD)) ? { done: true } : { done: false, why: `${folder} is not made yet` }),
    async apply() {
      await mkdir(folder, { recursive: true });
      await writeFile(join(checkoutFolder(run.root, run.checkout), CHECKOUT_FILE), run.checkout);
      await writeFile(join(folder, RECORD), JSON.stringify({ pid: run.pid, started: run.started }));
    },
    async remove(_ctx, progress) {
      await rm(folder, { recursive: true, force: true });
      progress.line(`removed ${folder}`);
    },
  };
}

async function runOfFolder(folder: string, name: string): Promise<{ pid: number; started?: string } | undefined> {
  if (!/^\d+$/.test(name)) return undefined;
  const record = await readOr(() => readFile(join(folder, name, RECORD), 'utf8'), gone);
  return record === undefined ? { pid: Number(name) } : JSON.parse(record) as { pid: number; started: string };
}

async function goneRunFolders(folder: string, said: (pid: number) => string): Promise<Leftover[]> {
  const names = await readOr(() => readdir(folder), gone) ?? [];
  const found: Leftover[] = [];
  for (const name of names) {
    const owner = await runOfFolder(folder, name);
    if (!owner || await alive(owner.pid, owner.started)) continue;
    const path = join(folder, name);
    found.push({ said: `${said(owner.pid)}: ${path}`, remove: async () => { await rm(path, { recursive: true, force: true }); } });
  }
  return found;
}

async function leftFolders(run: TestRun): Promise<Leftover[]> {
  const found = await goneRunFolders(checkoutFolder(run.root, run.checkout), (pid) => `removed the folder of gone test run ${pid}`);
  const own = checkoutKey(run.checkout);
  for (const key of await readOr(() => readdir(run.root), gone) ?? []) {
    if (key === own) continue;
    const folder = join(run.root, key);
    const checkout = await readOr(() => readFile(join(folder, CHECKOUT_FILE), 'utf8'), gone);
    if (checkout === undefined || existsSync(checkout)) continue;
    found.push(...await goneRunFolders(folder, (pid) => `removed the folder of test run ${pid} of ${checkout}, a checkout that is gone`));
  }
  return found;
}

async function ancestors(): Promise<Set<number>> {
  const found = new Set<number>();
  for (let pid = process.pid; pid > 1 && !found.has(pid);) {
    found.add(pid);
    pid = (await statOf(pid))?.parent ?? 1;
  }
  return found;
}

function ranBy(environ: string): { pid: number; started: string; checkout: string } | undefined {
  const entry = environ.split('\0').find((one) => one.startsWith(`${RUN_VARIABLE}=`));
  if (!entry) return undefined;
  const [pid = '', started = '', ...checkout] = entry.slice(RUN_VARIABLE.length + 1).split(':');
  return { pid: Number(pid), started, checkout: checkout.join(':') };
}

async function why(run: TestRun, pid: number): Promise<string | undefined> {
  const environ = await readOr(() => readFile(`/proc/${pid}/environ`, 'utf8'), notOurs);
  if (environ === undefined) return undefined;
  const maker = ranBy(environ);
  if (maker) {
    if (maker.checkout === run.checkout && !(await alive(maker.pid, maker.started))) return `left by gone test run ${maker.pid}`;
    if (!existsSync(maker.checkout)) return `left by test run ${maker.pid} of ${maker.checkout}, a checkout that is gone`;
    return undefined;
  }
  const cwd = await readOr(() => readlink(`/proc/${pid}/cwd`), notOurs);
  const cmdline = await readOr(() => readFile(`/proc/${pid}/cmdline`, 'utf8'), notOurs);
  if (cwd?.endsWith(DELETED) && cmdline?.includes('vitest')) return `whose worktree ${cwd.slice(0, -DELETED.length)} is gone`;
  return undefined;
}

async function leftProcesses(run: TestRun): Promise<Leftover[]> {
  const spared = await ancestors();
  const found: Leftover[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (spared.has(pid) || pid === run.pid) continue;
    const reason = await why(run, pid);
    if (!reason) continue;
    const stat = await statOf(pid);
    const cmdline = (await readOr(() => readFile(`/proc/${pid}/cmdline`, 'utf8'), notOurs) ?? '').split('\0').filter(Boolean).join(' ');
    if (!stat) continue;
    found.push({
      said: `stopped process ${pid} (${cmdline}), ${reason}`,
      async remove() {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          if (!gone(err)) throw err;
        }
        await waitUntil(`process ${pid} to end`, async () => ((await alive(pid, stat.started)) ? waiting(`process ${pid} is still running`) : true));
      },
    });
  }
  return found;
}

async function leftContainers(run: TestRun): Promise<Leftover[]> {
  return (await throwawayOrphans(run.checkout)).map((name) => ({ said: `removed throwaway container ${name}, whose test run is gone`, remove: () => removeThrowaway(name) }));
}

export interface LeftoversOptions {
  containers?: boolean;
}

async function leftovers(run: TestRun, options: LeftoversOptions): Promise<Leftover[]> {
  return [...await leftProcesses(run), ...await leftFolders(run), ...(options.containers ? await leftContainers(run) : [])];
}

export function leftoversStep(run: TestRun, options: LeftoversOptions = {}): Step<WorldContext> {
  return {
    id: 'leftovers',
    title: `What this checkout's gone test runs left${options.containers ? ', containers included' : ''}`,
    async check() {
      const found = await leftovers(run, options);
      return found.length === 0 ? { done: true } : { done: false, why: `gone test runs left ${found.map((one) => one.said.replace(/^(removed|stopped) /, '')).join('; ')}` };
    },
    async apply(_ctx, progress) {
      for (const leftover of await leftovers(run, options)) {
        await leftover.remove(progress);
        progress.line(leftover.said);
      }
    },
  };
}
