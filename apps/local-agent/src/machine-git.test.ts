import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMachineGit, remoteFor } from './machine-git.js';

let root: string;
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('a machine\'s checkout of a project\'s work', () => {
  it('fetches a work branch into its own folder, then commits and pushes what changed back to it', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'machine-git-'));
    const bare = path.join(root, 'tree.git');
    const seed = path.join(root, 'seed');
    execFileSync('mkdir', ['-p', bare, seed]);
    git(bare, 'init', '-q', '--bare');
    git(seed, 'init', '-q', '-b', 'main');
    await writeFile(path.join(seed, 'README.md'), 'labels\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'start');
    git(seed, 'push', '-q', bare, 'HEAD:refs/heads/machine/desk/run-1');

    const machine = createMachineGit({ rootDir: path.join(root, 'home'), backendUrl: 'http://koala.test', token: 'device-token', remote: () => bare });
    const fetched = await machine({ kind: 'checkout', repo: 'tree-t1', branch: 'machine/desk/run-1', folder: 'tree-t1/trees/l1' });
    expect(fetched).toEqual({ ok: true, path: 'koala-trees/tree-t1/trees/l1', commit: git(seed, 'rev-parse', 'HEAD') });
    const folder = path.join(root, 'home', 'koala-trees', 'tree-t1', 'trees', 'l1');
    expect(await readFile(path.join(folder, 'README.md'), 'utf8')).toBe('labels\n');

    await writeFile(path.join(folder, 'label.txt'), 'Axial Concepts\n');
    const pushed = await machine({ kind: 'push', repo: 'tree-t1', branch: 'machine/desk/run-1', folder: 'tree-t1/trees/l1', message: 'antigravity: the label' });
    expect(pushed.ok).toBe(true);
    expect(git(bare, 'log', '-1', '--format=%s', 'machine/desk/run-1')).toBe('antigravity: the label');
    expect(() => git(folder, 'config', '--get-regexp', 'remote|extraheader')).toThrow();

    const again = await machine({ kind: 'push', repo: 'tree-t1', branch: 'machine/desk/run-1', folder: 'tree-t1/trees/l1', message: 'nothing new' });
    expect(again).toMatchObject({ ok: true, commit: pushed.ok ? pushed.commit : '' });
  });

  it('lays the work over what the workspace already took when the agent rewrites those commits, so it still fast-forwards', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'machine-git-'));
    const bare = path.join(root, 'tree.git');
    const seed = path.join(root, 'seed');
    execFileSync('mkdir', ['-p', bare, seed]);
    git(bare, 'init', '-q', '--bare');
    git(seed, 'init', '-q', '-b', 'main');
    await writeFile(path.join(seed, 'README.md'), 'labels\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'start');
    git(seed, 'push', '-q', bare, 'HEAD:refs/heads/machine/desk/run-1');
    const machine = createMachineGit({ rootDir: path.join(root, 'home'), backendUrl: 'http://koala.test', token: 'device-token', remote: () => bare });
    const at = { repo: 'tree-t1', branch: 'machine/desk/run-1', folder: 'tree-t1/trees/l1' };
    await machine({ kind: 'checkout', ...at });
    const folder = path.join(root, 'home', 'koala-trees', 'tree-t1', 'trees', 'l1');

    await writeFile(path.join(folder, 'labels.spec.ts'), 'first\n');
    const synced = await machine({ kind: 'push', ...at, message: 'Work so far, for run_in_workspace' });
    expect(synced.ok).toBe(true);
    const taken = git(bare, 'rev-parse', 'machine/desk/run-1');

    await writeFile(path.join(folder, 'labels.spec.ts'), 'second\n');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-q', '--amend', '-m', 'Add the labels spec');
    await writeFile(path.join(folder, 'notes.md'), 'left uncommitted\n');

    const back = await machine({ kind: 'push', ...at, message: 'antigravity: the labels spec' });
    expect(back.ok).toBe(true);
    const pushed = git(bare, 'rev-parse', 'machine/desk/run-1');
    expect(git(bare, 'rev-parse', `${pushed}^`)).toBe(taken);
    expect(git(bare, 'log', '-1', '--format=%s', pushed)).toBe('antigravity: the labels spec');
    expect(git(bare, 'show', `${pushed}:labels.spec.ts`)).toBe('second');
    expect(git(bare, 'show', `${pushed}:notes.md`)).toBe('left uncommitted');
    expect(git(folder, 'status', '--porcelain')).toBe('');
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(pushed);
  });

  it('keeps out of anything outside its folder, and says what failed without the token', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'machine-git-'));
    const machine = createMachineGit({ rootDir: path.join(root, 'home'), backendUrl: 'http://koala.test', token: 'device-token', remote: () => path.join(root, 'missing.git') });
    expect(await machine({ kind: 'checkout', repo: 'r', branch: 'b', folder: '../../etc' })).toEqual({ ok: false, error: '../../etc is outside this machine\'s folder' });
    const failed = await machine({ kind: 'checkout', repo: 'r', branch: 'b', folder: 'tree/repo' });
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error).not.toContain('device-token');
    expect(remoteFor('http://koala.test/', 'tree-t1')).toBe('http://koala.test/api/machines/git/tree-t1.git');
  });
});
