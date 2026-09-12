import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(execCallback);

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_CHARS = 30_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
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
  rootDir: string, command: string, timeoutMs = DEFAULT_TIMEOUT_MS, subPath?: string,
): Promise<ExecResult> {
  try {
    const cwd = subPath ? resolveInRoot(rootDir, subPath) : rootDir;
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_CHARS * 4,
    });
    return {
      stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
      exitCode: 0,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number; killed?: boolean; signal?: string };
    return {
      stdout: (e.stdout ?? '').toString().slice(0, MAX_OUTPUT_CHARS),
      stderr: (e.stderr ?? e.message ?? '').toString().slice(0, MAX_OUTPUT_CHARS),
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
