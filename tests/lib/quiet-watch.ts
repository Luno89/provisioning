import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { here } from './processes.js';
import { GROUP, QUIET_AFTER_MS } from './test-runs.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TSX = resolve(ROOT, 'node_modules', '.bin', 'tsx');
const STATUS = resolve(import.meta.dirname, 'test-status.ts');

export interface QuietWatch { env: Record<string, string>; stop: () => void }
export interface QuietWatchOptions { after?: number; out?: number | 'inherit'; env?: Record<string, string> }

export function watchQuiet(options: QuietWatchOptions = {}): QuietWatch {
  const group = randomUUID();
  const out = options.out ?? 'inherit';
  const said = (chunk: string): void => {
    if (out === 'inherit') process.stdout.write(chunk);
    else writeSync(out, chunk);
  };
  const watcher = here.start({ command: TSX, args: [STATUS, 'watch', group, String(options.after ?? QUIET_AFTER_MS), String(process.pid)], env: options.env ?? {} }, { heard: { stdout: said, stderr: said } });
  return {
    env: { [GROUP]: group },
    stop: () => { watcher.stop('SIGTERM'); },
  };
}
