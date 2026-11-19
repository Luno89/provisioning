import fs from 'fs/promises';
import path from 'path';

import { clampDualBoundary, DEFAULT_COMPACTION_CONFIG } from '@koala/context-engine';
import { passedOn, PERSON_SESSION } from '@koala/engine-core/child-env';
import { execForModel } from '@koala/engine-core/model-exec';
import { nodeStreams } from '@koala/engine-core/node-processes';
import type { Streams } from '@koala/engine-core/processes';

const NO_EXIT = -1;

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
  streams?: Streams | undefined;
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

  const timeoutMs = options.timeoutMs ?? 0;
  const maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const headRatio = options.headRatio ?? DEFAULT_COMPACTION_CONFIG.outputHeadRatio;
  const targetSubPath = options.subPath ?? subPath;
  const clamped = (text: string): string => clampDualBoundary(text, { maxChars: maxOutputChars, headRatio });

  let cwd: string;
  try {
    cwd = targetSubPath ? resolveInRoot(rootDir, targetSubPath) : rootDir;
  } catch (err) {
    return { stdout: '', stderr: clamped((err as Error).message), exitCode: NO_EXIT, timedOut: false };
  }
  const ran = await execForModel(
    { streams: options.streams ?? nodeStreams, shell: ['/bin/sh', '-c'], cwd, env: passedOn(PERSON_SESSION) },
    { command, ...(timeoutMs > 0 ? { timeoutMs } : {}) },
  );
  return {
    stdout: clamped(ran.stdout),
    stderr: clamped(ran.stderr),
    exitCode: ran.stopped ? NO_EXIT : ran.exitCode,
    timedOut: ran.stopped === 'timeout',
  };
}

export async function readLocalFile(rootDir: string, relativePath: string): Promise<{ content: string } | { error: string }> {
  try {
    const target = resolveInRoot(rootDir, relativePath);
    return { content: await fs.readFile(target, 'utf8') };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeLocalFile(rootDir: string, relativePath: string, content: string | Buffer): Promise<{ error: string } | undefined> {
  try {
    const target = resolveInRoot(rootDir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
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
