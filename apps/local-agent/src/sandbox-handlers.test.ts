import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveInRoot, runCommand, readLocalFile, writeLocalFile, listLocalDir, deleteLocalFile } from './sandbox-handlers.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-local-agent-'));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('resolveInRoot', () => {
  it('resolves a relative path inside the root', () => {
    expect(resolveInRoot(rootDir, 'a/b.txt')).toBe(path.join(rootDir, 'a/b.txt'));
  });

  it('refuses an absolute path', () => {
    expect(() => resolveInRoot(rootDir, '/etc/passwd')).toThrow(/must be relative/);
  });

  it('refuses a path that escapes the root via ..', () => {
    expect(() => resolveInRoot(rootDir, '../../etc/passwd')).toThrow(/escapes the root/);
  });

  it('allows the root itself', () => {
    expect(resolveInRoot(rootDir, '.')).toBe(rootDir);
  });
});

describe('runCommand', () => {
  it('runs a command inside the root directory and reports success', async () => {
    const result = await runCommand(rootDir, 'pwd');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe(rootDir);
  });

  it('reports a non-zero exit code without throwing', async () => {
    const result = await runCommand(rootDir, 'exit 3');
    expect(result.exitCode).toBe(3);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await runCommand(rootDir, 'echo out; echo err 1>&2');
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });
});

describe('readLocalFile / writeLocalFile', () => {
  it('writes then reads a file back, creating directories as needed', async () => {
    const written = await writeLocalFile(rootDir, 'nested/dir/file.txt', 'hello');
    expect(written).toBeUndefined();

    const read = await readLocalFile(rootDir, 'nested/dir/file.txt');
    expect(read).toEqual({ content: 'hello' });
  });

  it('returns an error instead of throwing when the file does not exist', async () => {
    const read = await readLocalFile(rootDir, 'missing.txt');
    expect(read).toHaveProperty('error');
  });

  it('refuses to write outside the root directory', async () => {
    const result = await writeLocalFile(rootDir, '../escape.txt', 'nope');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/escapes the root/);
  });
});

describe('listLocalDir', () => {
  it('lists files and directories, and excludes .git', async () => {
    await writeLocalFile(rootDir, 'src/index.ts', 'export {}');
    await writeLocalFile(rootDir, 'README.md', '# hi');
    await fs.mkdir(path.join(rootDir, '.git'));

    const result = await listLocalDir(rootDir, '');
    expect(result).not.toHaveProperty('error');
    const entries = (result as { entries: { name: string; path: string; type: string }[] }).entries;
    expect(entries.find((e) => e.name === '.git')).toBeUndefined();
    expect(entries).toContainEqual({ name: 'README.md', path: 'README.md', type: 'file' });
    expect(entries).toContainEqual({ name: 'src', path: 'src', type: 'dir' });
  });

  it('joins the subpath onto each entry path', async () => {
    await writeLocalFile(rootDir, 'src/index.ts', 'export {}');
    const result = await listLocalDir(rootDir, 'src');
    const entries = (result as { entries: { name: string; path: string; type: string }[] }).entries;
    expect(entries).toContainEqual({ name: 'index.ts', path: 'src/index.ts', type: 'file' });
  });

  it('returns an error for a directory that does not exist', async () => {
    const result = await listLocalDir(rootDir, 'ghost');
    expect(result).toHaveProperty('error');
  });
});

describe('deleteLocalFile', () => {
  it('removes a file', async () => {
    await writeLocalFile(rootDir, 'a.txt', 'bye');
    const result = await deleteLocalFile(rootDir, 'a.txt');
    expect(result).toBeUndefined();
    expect(await readLocalFile(rootDir, 'a.txt')).toHaveProperty('error');
  });

  it('refuses to delete outside the root directory', async () => {
    const result = await deleteLocalFile(rootDir, '../escape.txt');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/escapes the root/);
  });
});
