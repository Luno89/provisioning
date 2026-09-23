import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

import { clampDualBoundary, DEFAULT_COMPACTION_CONFIG } from '@koala/context-engine';

const execAsync = promisify(execCallback);

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_CHARS = DEFAULT_COMPACTION_CONFIG.maxOutputChars;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface RunCommandOptions {
  timeoutMs?: number | undefined;
  subPath?: string | undefined;
  maxOutputChars?: number | undefined;
  headRatio?: number | undefined;
}

export function resolveInRoot(rootDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Path ${JSON.stringify(relativePath)} must be relative to the device's root directory`);
  }
  const resolved = path.resolve(rootDir, relativePath);
  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error(`Path ${JSON.stringify(relativePath)} escapes the root directory`);
  }
  return resolved;
}

export async function runCommand(
  rootDir: string,
  command: string,
  timeoutMsOrOptions?: number | RunCommandOptions | undefined,
  subPath?: string,
): Promise<ExecResult> {
  const options: RunCommandOptions = typeof timeoutMsOrOptions === 'number'
    ? { timeoutMs: timeoutMsOrOptions, ...(subPath !== undefined ? { subPath } : {}) }
    : (timeoutMsOrOptions ?? (subPath !== undefined ? { subPath } : {}));

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const headRatio = options.headRatio ?? DEFAULT_COMPACTION_CONFIG.outputHeadRatio;
  const targetSubPath = options.subPath ?? subPath;

  try {
    const cwd = targetSubPath ? resolveInRoot(rootDir, targetSubPath) : rootDir;
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: Math.max(1024 * 1024, maxOutputChars * 4),
    });
    return {
      stdout: clampDualBoundary(stdout, { maxChars: maxOutputChars, headRatio }),
      stderr: clampDualBoundary(stderr, { maxChars: maxOutputChars, headRatio }),
      exitCode: 0,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number; killed?: boolean; signal?: string };
    return {
      stdout: clampDualBoundary((e.stdout ?? '').toString(), { maxChars: maxOutputChars, headRatio }),
      stderr: clampDualBoundary((e.stderr ?? e.message ?? '').toString(), { maxChars: maxOutputChars, headRatio }),
      exitCode: typeof e.code === 'number' ? e.code : -1,
      timedOut: e.killed === true && e.signal === 'SIGTERM',
    };
  }
}

export async function readLocalFile(rootDir: string, relativePath: string): Promise<{ content: string } | { error: string }> {
  try {
    const target = resolveInRoot(rootDir, relativePath);
    return { content: await fs.readFile(target, 'utf8') };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeLocalFile(rootDir: string, relativePath: string, content: string): Promise<{ error: string } | undefined> {
  try {
    const target = resolveInRoot(rootDir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return undefined;
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface LocalDirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

export async function listLocalDir(rootDir: string, relativePath: string): Promise<{ entries: LocalDirEntry[] } | { error: string }> {
  try {
    const target = resolveInRoot(rootDir, relativePath);
    const items = await fs.readdir(target, { withFileTypes: true });
    const entries = items
      .filter((i) => i.name !== '.git')
      .map((i) => ({
        name: i.name,
        path: relativePath ? `${relativePath}/${i.name}` : i.name,
        type: i.isDirectory() ? 'dir' as const : 'file' as const,
      }));
    return { entries };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteLocalFile(rootDir: string, relativePath: string): Promise<{ error: string } | undefined> {
  try {
    const target = resolveInRoot(rootDir, relativePath);
    await fs.unlink(target);
    return undefined;
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
