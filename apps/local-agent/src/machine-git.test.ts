import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import type { ProcessRun } from '@koala/engine-core/processes';
import { createMachineGit } from './machine-git.js';

type Answer = { code: number; stdout?: string; stderr?: string };

const said = (run: ProcessRun): string => (run.args ?? []).join(' ');

const pushing = (failing: (line: string) => Answer | undefined) => {
  const processes = recordingProcesses((run) => {
    const line = said(run);
    const failed = failing(line);
    if (failed) return failed;
    if (line.startsWith('rev-parse --verify -q')) return { code: 0, stdout: 'abc123\n' };
    if (line.startsWith('diff --cached --quiet')) return { code: 1, stdout: '' };
    return { code: 0, stdout: '' };
  });
  const git = createMachineGit({ rootDir: '/home/bo/koala', backendUrl: 'http://koala.test', token: 'device-token', processes });
  const pushed = () => processes.ran.some((run) => run.args?.includes('push'));
  return { push: () => git({ kind: 'push', repo: 'tree-t1', branch: 'main', folder: 'tree-t1', message: 'Work' }), pushed };
};

const BROKEN: Answer = { code: 128, stderr: 'fatal: index file corrupt' };

describe('sending a machine\'s work back when git itself fails', () => {
  it('stops before the push, with what git said, when the conflicted files cannot be listed', async () => {
    const world = pushing((line) => (line === 'diff --name-only --diff-filter=U' ? BROKEN : undefined));
    expect(await world.push()).toEqual({ ok: false, error: 'could not list the files left in conflict: fatal: index file corrupt' });
    expect(world.pushed()).toBe(false);
  });

  it('stops before the push, with what git said, when the work cannot be checked for conflict markers', async () => {
    const world = pushing((line) => (line.startsWith('diff --cached --check') ? BROKEN : undefined));
    expect(await world.push()).toEqual({ ok: false, error: 'could not check the work for conflict markers: fatal: index file corrupt' });
    expect(world.pushed()).toBe(false);
  });

  it('stops before the push, with what git said, when what the workspace has cannot be read', async () => {
    const world = pushing((line) => (line.startsWith('rev-parse --verify -q') ? BROKEN : undefined));
    expect(await world.push()).toEqual({ ok: false, error: 'could not read what the workspace has: fatal: index file corrupt' });
    expect(world.pushed()).toBe(false);
  });

  it('stops before the push, with what git said, when it cannot tell whether the work was rewritten', async () => {
    const world = pushing((line) => (line.startsWith('merge-base --is-ancestor') ? BROKEN : undefined));
    expect(await world.push()).toEqual({ ok: false, error: 'could not tell whether the work was rewritten: fatal: index file corrupt' });
    expect(world.pushed()).toBe(false);
  });

  it('stops before the push, with what git said, when it cannot tell whether there is work to commit', async () => {
    const world = pushing((line) => (line.startsWith('diff --cached --quiet') ? BROKEN : undefined));
    expect(await world.push()).toEqual({ ok: false, error: 'could not tell whether there is work to commit: fatal: index file corrupt' });
    expect(world.pushed()).toBe(false);
  });

  it('names the files git finds conflict markers in, and pushes nothing', async () => {
    const world = pushing((line) => (line.startsWith('diff --cached --check') ? { code: 2, stdout: 'shop.py:3: leftover conflict marker\n' } : undefined));
    expect(await world.push()).toEqual({ ok: false, error: 'these files still hold conflict markers: shop.py', unresolved: ['shop.py'] });
    expect(world.pushed()).toBe(false);
  });

  it('pushes the work when every git command answers', async () => {
    const world = pushing(() => undefined);
    expect(await world.push()).toMatchObject({ ok: true });
    expect(world.pushed()).toBe(true);
  });
});
