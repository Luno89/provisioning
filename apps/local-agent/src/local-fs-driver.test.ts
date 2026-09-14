import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLocalFsDriver } from './local-fs-driver.js';
import { ScopeError, executeTool, type ToolContract } from '@koala/engine-core';

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-agent-'));
  await fs.mkdir(path.join(rootDir, 'project/src'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'project/src/a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(rootDir, 'secret.txt'), 'do not read me\n');
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const driverFor = (scope?: { path?: string; worktree?: string }) =>
  createLocalFsDriver({
    rootDir,
    deviceId: 'tallgeese',
    ...(scope ? { scope } : {}),
    defaultTimeoutMs: 10_000,
  });

describe('local filesystem driver', () => {
  it('presents itself as a persistent machine that needs no approval of its own', () => {
    const handle = driverFor().handle();

    expect(handle.spec).toMatchObject({ kind: 'machine', lifecycle: 'persistent' });
    expect(handle.capabilities).toMatchObject({ terminal: true, filesystem: true, egress: true });
    expect(handle.approval).toBe('none');
  });

  it('reads and writes real files under the root', async () => {
    const driver = driverFor();

    expect(await driver.readFile('project/src/a.ts')).toContain('export const a');

    await driver.writeFile('project/src/b.ts', 'export const b = 2;\n');
    expect(await fs.readFile(path.join(rootDir, 'project/src/b.ts'), 'utf8')).toContain('export const b');
  });

  it('creates missing directories when writing', async () => {
    await driverFor().writeFile('brand/new/place/file.txt', 'hello');
    expect(await fs.readFile(path.join(rootDir, 'brand/new/place/file.txt'), 'utf8')).toBe('hello');
  });

  it('lists a directory, hiding .git', async () => {
    await fs.mkdir(path.join(rootDir, 'project/.git'), { recursive: true });
    const entries = await driverFor().listDir('project');

    expect(entries.map((entry) => entry.name).sort()).toEqual(['src']);
    expect(entries[0]).toMatchObject({ type: 'dir' });
  });

  it('deletes a file', async () => {
    const driver = driverFor();
    await driver.deleteFile('project/src/a.ts');

    await expect(fs.access(path.join(rootDir, 'project/src/a.ts'))).rejects.toThrow();
  });

  it('runs a real command in the root and captures its output', async () => {
    const result = await driverFor().exec({ command: 'echo hello from the machine' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from the machine');
  });

  it('reports a failing command with its exit code and stderr', async () => {
    const result = await driverFor().exec({ command: 'ls /definitely/not/here' });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });

  it('kills a command that runs past its timeout instead of hanging', async () => {
    const result = await driverFor().exec({ command: 'sleep 5', timeoutMs: 300 });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('stopped after');
  });

  it('runs commands inside the scoped path, not the root', async () => {
    const result = await driverFor({ path: 'project/src' }).exec({ command: 'pwd' });

    expect(result.stdout.trim().endsWith('project/src')).toBe(true);
  });

  it('confines file access to the scoped path', async () => {
    const driver = driverFor({ path: 'project' });

    expect(await driver.readFile('src/a.ts')).toContain('export const a');
    await expect(driver.readFile('../secret.txt')).rejects.toThrow(ScopeError);
  });

  it('keeps a fan-out child inside its own worktree', async () => {
    await fs.mkdir(path.join(rootDir, 'wt/child-1'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'wt/child-1/only-here.txt'), 'mine');

    const driver = driverFor({ path: 'project', worktree: 'wt/child-1' });

    expect(await driver.readFile('only-here.txt')).toBe('mine');
    await expect(driver.readFile('../child-2/theirs.txt')).rejects.toThrow(ScopeError);
  });
});

describe('the shared tool executor, running against a real machine', () => {
  const catalogue: ToolContract[] = [
    { name: 'run_command', description: 'Run a shell command', binding: 'environment', requires: { terminal: true } },
    { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
    { name: 'search_web', description: 'Search the web', binding: 'network' },
  ];

  it('executes a granted tool through the local driver', async () => {
    const outcome = await executeTool({
      name: 'run_command',
      arguments: JSON.stringify({ command: 'echo done' }),
      granted: ['run_command', 'read_file'],
      catalogue,
      driver: driverFor(),
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.digest.trim()).toBe('done');
  });

  it('refuses a tool the agent was not granted, with the same wording as the server', async () => {
    const outcome = await executeTool({
      name: 'search_web',
      arguments: '{}',
      granted: ['run_command'],
      catalogue,
      driver: driverFor(),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('not a tool this agent can use');
  });

  it('turns an escape attempt into a refusal rather than reading the file', async () => {
    const outcome = await executeTool({
      name: 'read_file',
      arguments: JSON.stringify({ path: '../secret.txt' }),
      granted: ['read_file'],
      catalogue,
      driver: driverFor({ path: 'project' }),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('points outside');
    expect(outcome.digest).not.toContain('do not read me');
  });
});
