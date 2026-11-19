import { mkdirSync, watch } from 'node:fs';
import { liveRuns, QUIET_AFTER_MS, quietLine, type RunStatus } from './test-runs.js';

export interface QuietNotice { run: RunStatus; line: string }
export interface QuietFollow { stop: () => void }
export interface RunSource { runs: () => RunStatus[]; changes: (changed: () => void) => () => void }
export interface QuietFollowOptions { after?: number; group?: string }

export function runsIn(dir: string): RunSource {
  return {
    runs: () => liveRuns(dir),
    changes: (changed) => {
      mkdirSync(dir, { recursive: true });
      const watcher = watch(dir, changed);
      return () => watcher.close();
    },
  };
}

interface Kept { pid: number; id: string; changedAt: number; timer: NodeJS.Timeout }

export function followQuiet(source: RunSource, tell: (notice: QuietNotice) => void, options: QuietFollowOptions = {}): QuietFollow {
  const after = options.after ?? QUIET_AFTER_MS;
  const kept = new Map<string, Kept>();
  const runs = (): RunStatus[] => source.runs().filter((run) => options.group === undefined || run.group === options.group);

  const due = (entry: Omit<Kept, 'timer'>, at: number): void => {
    const key = `${entry.pid} ${entry.id}`;
    kept.set(key, { ...entry, timer: setTimeout(() => quiet(key), Math.max(0, at - Date.now())) });
  };

  const quiet = (key: string): void => {
    const entry = kept.get(key);
    if (!entry) return;
    const run = runs().find((one) => one.pid === entry.pid);
    const file = run?.files[entry.id];
    if (!run || !file || file.changedAt !== entry.changedAt) { kept.delete(key); look(); return; }
    const now = Date.now();
    tell({ run, line: quietLine(file, now) });
    due(entry, now + after);
  };

  const look = (): void => {
    const seen = new Set<string>();
    for (const run of runs()) {
      for (const [id, file] of Object.entries(run.files)) {
        const key = `${run.pid} ${id}`;
        seen.add(key);
        const known = kept.get(key);
        if (known?.changedAt === file.changedAt) continue;
        if (known) clearTimeout(known.timer);
        due({ pid: run.pid, id, changedAt: file.changedAt }, file.changedAt + after);
      }
    }
    for (const [key, entry] of kept) if (!seen.has(key)) { clearTimeout(entry.timer); kept.delete(key); }
  };

  const unwatch = source.changes(look);
  look();
  return {
    stop: () => {
      unwatch();
      for (const entry of kept.values()) clearTimeout(entry.timer);
      kept.clear();
    },
  };
}
