import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvironmentDriver } from '@koala/engine-core';
import { createGroveOperations, type GroveOperationDeps } from './handlers.js';
import type { Leaf } from '../../../projects/lib/leaves.js';

const SANDBOX = { kind: 'sandbox', id: 'engine-tree-t1', workspace: { runId: 'tree-t1' }, capabilities: { kind: 'sandbox', lifecycle: 'invocation' } } as const;
const TREE = { id: 't1', name: 'Greeter', type: 'application' };

function workDriver(root: string, worktree: string | undefined): EnvironmentDriver {
  const inRoot = (text: string) => text.replaceAll('/work', root);
  const sh = (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => new Promise((resolve) => {
    const child = spawn('sh', ['-c', inRoot(command)], { cwd: worktree ? join(root, worktree) : root, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
  return {
    exec: async ({ command }: { command: string }) => sh(command),
    readFile: async (path: string) => readFileSync(join(root, worktree ?? '', path), 'utf8'),
    writeFile: async () => { throw new Error('nothing is written here'); },
    listDir: async () => [],
    deleteFile: async () => undefined,
  } as never;
}

const notUsed = (what: string) => async () => { throw new Error(`${what} is not used here`); };

function grove(root: string, leaves: () => Leaf[]): GroveOperationDeps {
  return {
    trees: { list: async () => [] },
    branches: { list: async () => [{ id: 'b1', treeId: 't1', ownerId: 'user-1', title: 'greeting', createdAt: 'then', updatedAt: 'then' } as never] },
    leaves: { list: async () => leaves(), save: async () => undefined },
    tasks: { list: async () => [], save: async () => undefined },
    plans: { list: async () => [] },
    treeWorkspaces: { describe: notUsed('describe'), compose: notUsed('compose'), state: notUsed('state'), save: notUsed('save'), park: notUsed('park'), release: notUsed('release'), bring: notUsed('bring'), land: notUsed('land') } as never,
    environments: { forRun: async (request) => workDriver(root, request.environment?.scope?.worktree) },
    registry: { runnable: async () => undefined },
    now: () => 'now',
  };
}

const leaf = (id: string, over: Partial<Leaf> = {}): Leaf => ({ id, ownerId: 'user-1', branchId: 'b1', title: `leaf ${id}`, body: `${id} works`, status: 'pending', createdAt: 'then', updatedAt: 'then', ...over } as Leaf);

function prepare(root: string, leaves: Leaf[], wanted: string[]) {
  const request = {
    node: { id: 'op', kind: 'host-op', settings: { operation: 'grove.prepare-worktrees' }, position: { x: 0, y: 0 } },
    origin: 'op',
    inputs: { tree: TREE, environment: SANDBOX, leaves: wanted.map((id) => ({ leafId: id, leafTitle: `leaf ${id}` })) },
    execution: 1,
    run: { identity: { runId: 'run-g', depth: 0, agentId: 'grove', loopId: 'grove-run', loopVersion: '1', trigger: 'user' }, launch: { ownerId: 'user-1' }, handles: new Set(), inputs: {}, counters: {}, budget: {}, cleaningUp: false, emit: () => undefined },
  };
  return createGroveOperations(grove(root, () => leaves))['grove.prepare-worktrees']!(request as never) as Promise<{ exit: string; outputs?: Record<string, unknown> }>;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

describe('the worktrees a tree\'s stories are worked in, with real git', () => {
  it('gives each story a folder and branch of its own, starts a dependent story from the commit its dependency claimed, and prunes a deleted story', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grove-work-'));
    expect((await prepare(root, [leaf('a'), leaf('c')], ['a', 'c'])).exit).toBe('ready');
    expect(git(join(root, 'trees/a'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('leaf/a');
    expect(git(join(root, 'trees/c'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('leaf/c');

    execFileSync('sh', ['-c', 'echo "hello from a" > greet.txt'], { cwd: join(root, 'trees/a') });
    git(join(root, 'trees/a'), 'add', '-A');
    git(join(root, 'trees/a'), 'commit', '-qm', 'a does its work');
    const claimed = git(join(root, 'trees/a'), 'rev-parse', 'HEAD');
    execFileSync('sh', ['-c', 'echo "after the claim" >> greet.txt && git -c user.name=t -c user.email=t@t commit -qam "not claimed"'], { cwd: join(root, 'trees/a'), env: { PATH: process.env.PATH, HOME: root } });

    const now = [leaf('a', { status: 'claimed', claim: { evidence: 'did it', at: 'then', commit: claimed } } as never), leaf('b', { dependsOn: ['a'] })];
    expect((await prepare(root, now, ['b'])).exit).toBe('ready');
    expect(readFileSync(join(root, 'trees/b/greet.txt'), 'utf8')).toBe('hello from a\n');
    expect(git(join(root, 'trees/b'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('leaf/b');
    expect(existsSync(join(root, 'trees/c'))).toBe(false);
    expect(git(join(root, 'repo'), 'branch', '--list', 'leaf/c')).toBe('');
    expect(existsSync(join(root, 'trees/a/greet.txt'))).toBe(true);
  });
});
