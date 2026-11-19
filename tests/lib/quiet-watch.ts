import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { GROUP, QUIET_AFTER_MS } from './test-runs.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TSX = resolve(ROOT, 'node_modules', '.bin', 'tsx');
const STATUS = resolve(import.meta.dirname, 'test-status.ts');

export interface QuietWatch { env: Record<string, string>; stop: () => void }
export interface QuietWatchOptions { after?: number; out?: number | 'inherit'; env?: Record<string, string> }

export function watchQuiet(options: QuietWatchOptions = {}): QuietWatch {
  const group = randomUUID();
  const out = options.out ?? 'inherit';
  const watcher = spawn(TSX, [STATUS, 'watch', group, String(options.after ?? QUIET_AFTER_MS)], { stdio: ['pipe', out, out], env: { ...process.env, ...(options.env ?? {}) } });
  return {
    env: { [GROUP]: group },
    stop: () => { if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill(); },
  };
}
