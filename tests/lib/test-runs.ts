import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

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

export function liveRuns(dir: string = runsDir()): RunStatus[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const path = join(dir, name);
    let status: RunStatus;
    try {
      status = JSON.parse(readFileSync(path, 'utf8')) as RunStatus;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`the test run status ${path} could not be read: ${(err as Error).message}`);
    }
    if (alive(status.pid)) return [status];
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

export interface Told { changedAt: number; at: number }

export function dueQuiet(runs: readonly RunStatus[], now: number, told: Map<string, Told>, after: number = QUIET_AFTER_MS): string[] {
  return runs.flatMap((run) => Object.entries(run.files).flatMap(([id, file]) => {
    const key = `${run.pid} ${id}`;
    if (now - file.changedAt < after) return [];
    const last = told.get(key);
    if (last && last.changedAt === file.changedAt && now - last.at < after) return [];
    told.set(key, { changedAt: file.changedAt, at: now });
    return [quietLine(file, now)];
  }));
}

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
