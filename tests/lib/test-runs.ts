import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { threadId } from 'node:worker_threads';

export interface RunningFile { file: string; startedAt: number; doing: string; doingSince: number; lastLine?: string; changedAt: number }
export interface RunStatus { pid: number; checkout: string; workspace: string; group?: string; startedAt: number; files: Record<string, RunningFile> }

export const RUNS_DIR = 'KOALA_TEST_RUNS';
export const GROUP = 'KOALA_TEST_GROUP';
export const QUIET_AFTER_MS = 4 * 60_000;
const LONGEST_LINE = 300;

export const runsDir = (): string => process.env[RUNS_DIR] ?? join(tmpdir(), `koala-test-runs-${userInfo().username}`);

export function keepStatus(dir: string, status: RunStatus): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${status.pid}.json`);
  writeFileSync(`${file}.next`, JSON.stringify(status));
  renameSync(`${file}.next`, file);
}

export const dropStatus = (dir: string, pid: number): void => rmSync(join(dir, `${pid}.json`), { force: true });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const RUN_FILE = /^(\d+)\.json$/;
const WORKER_FILE = /^(\d+)\.w(\d+)-\d+\.json$/;

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`the test run status ${path} could not be read: ${(err as Error).message}`);
  }
}

export function keepDoing(dir: string, run: string, doing: WorkerDoing): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${run}.w${process.pid}-${threadId}.json`);
  writeFileSync(`${file}.next`, JSON.stringify(doing));
  renameSync(`${file}.next`, file);
}

export const dropDoing = (dir: string, run: string): void => rmSync(join(dir, `${run}.w${process.pid}-${threadId}.json`), { force: true });

export function liveRuns(dir: string = runsDir()): RunStatus[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const workers = new Map<number, WorkerDoing[]>();
  for (const name of names) {
    const match = WORKER_FILE.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    if (!alive(Number(match[1])) || !alive(Number(match[2]))) { rmSync(path, { force: true }); continue; }
    const doing = readJson<WorkerDoing>(path);
    if (doing) workers.set(Number(match[1]), [...(workers.get(Number(match[1])) ?? []), doing]);
  }
  return names.filter((name) => RUN_FILE.test(name)).flatMap((name) => {
    const path = join(dir, name);
    const status = readJson<RunStatus>(path);
    if (!status) return [];
    if (alive(status.pid)) return [withWorkers(status, workers.get(status.pid) ?? [])];
    rmSync(path, { force: true });
    return [];
  }).sort((a, b) => a.startedAt - b.startedAt);
}

export function heard(file: RunningFile, content: string, now: number): RunningFile {
  const line = content.split('\n').map((one) => one.trim()).filter(Boolean).at(-1)?.slice(0, LONGEST_LINE);
  if (!line || line === file.lastLine) return file;
  return { ...file, lastLine: line, changedAt: now };
}

export const doing = (file: RunningFile, what: string, now: number): RunningFile => ({ ...file, doing: what, doingSince: now, changedAt: now });

export const spoken = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`);

export const quietLine = (file: RunningFile, now: number, name: string = basename(file.file)): string =>
  `${name} › ${file.doing}: quiet ${spoken(now - file.changedAt)}; ${file.lastLine ? `last said: ${file.lastLine}` : 'it has said nothing yet'}`;

const plural = (count: number, one: string, many: string): string => (count === 1 ? `1 ${one}` : `${count} ${many}`);

export function statusReport(runs: readonly RunStatus[], now: number): string[] {
  if (runs.length === 0) return ['no test runs are live on this machine'];
  return [
    `${plural(runs.length, 'test run', 'test runs')} live on this machine`,
    ...runs.flatMap((run) => {
      const files = Object.values(run.files);
      return [
        `${run.checkout} · ${run.workspace} · pid ${run.pid} · running ${spoken(now - run.startedAt)} · ${files.length === 0 ? 'no file running' : `${plural(files.length, 'file', 'files')} running`}`,
        ...files.map((file) => `  ${quietLine(file, now, file.file)}`),
      ];
    }),
  ];
}

export interface TaskShape { id: string; name: string; type: 'test' | 'suite'; mode: string; suite?: TaskShape; file?: TaskShape; tasks?: TaskShape[]; result?: { state?: string } }
export interface WorkerDoing { file: string; doing: string; since: number }

export const RUN_PID = 'KOALA_TEST_RUN_PID';

const suitesOf = (task: TaskShape): TaskShape[] => (task.suite && task.suite !== task.file ? [...suitesOf(task.suite), task.suite] : []);

export const testName = (test: TaskShape): string => [...suitesOf(test).map((suite) => suite.name), test.name].join(' › ');

const testsIn = (task: TaskShape): TaskShape[] => (task.type === 'test' ? [task] : (task.tasks ?? []).flatMap(testsIn));

export function afterTest(test: TaskShape): string {
  const toRun = testsIn(test.file ?? test).filter((one) => one !== test && one.mode === 'run' && !one.result?.state);
  if (toRun.length === 0) return 'afterAll';
  const suites = suitesOf(test);
  const finished = [...suites].reverse().find((suite) => !toRun.some((one) => suitesOf(one).includes(suite)));
  if (!finished) return 'between tests';
  return `${[...suites.slice(0, suites.indexOf(finished)).map((suite) => suite.name), finished.name].join(' › ')} › afterAll`;
}

export function withWorkers(run: RunStatus, workers: readonly WorkerDoing[]): RunStatus {
  const files = { ...run.files };
  for (const worker of workers) {
    const file = files[worker.file];
    if (!file || worker.since < file.doingSince) continue;
    files[worker.file] = { ...file, doing: worker.doing, doingSince: worker.since, changedAt: Math.max(file.changedAt, worker.since) };
  }
  return { ...run, files };
}
