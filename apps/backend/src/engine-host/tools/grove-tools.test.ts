import { describe, it, expect, beforeEach } from 'vitest';
import { createGroveTools } from './grove-tools.js';
import type { Branch, Leaf, LeafStatus } from '../../lib/leaves.js';
import type { Tree } from '../../lib/trees.js';
import { type Task, type TaskStatus } from '../../lib/tasks.js';

let trees: Tree[] = [];
let branches: Branch[] = [];
let leaves: Leaf[] = [];
let tasks: Task[] = [];
let nextId = 0;

const tools = () => createGroveTools({
  stores: {
    trees: { list: async () => trees, save: async (tree) => { trees = [tree]; } },
    branches: { list: async () => branches, save: async (branch) => { branches.push(branch); } },
    leaves: { list: async () => leaves, save: async (leaf) => { leaves.push(leaf); } },
    tasks: { list: async () => tasks },
  },
  newId: () => `g${++nextId}`,
  now: () => '2026-01-01T00:00:00.000Z',
});

const caller = { ownerId: 'user-1', projectId: 'project-9', runId: 'run-1', agentSlug: 'planner' };

const run = (
  name: string,
  parsed: Record<string, unknown>,
) => tools()[name]!({ name, parsed, driver: undefined, caller });

beforeEach(() => {
  trees = [{ id: 'tree-1', ownerId: 'user-1', name: 'The app', type: 'application', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' }];
  branches = [{
    id: 'branch-1',
    ownerId: 'user-1',
    treeId: 'tree-1',
    projectId: 'project-9',
    title: 'The direction',
    messages: [],
    createdAt: 'now',
    updatedAt: 'now',
  }];
  leaves = [];
  tasks = [];
  nextId = 0;
});

describe('make_branch', () => {
  it('branches the named tree, carrying the tree project along', async () => {
    const outcome = await run('make_branch', { treeId: 'tree-1', title: 'A blue-green deployment lane' });

    expect(outcome.ok).toBe(true);
    const made = branches.at(-1)!;
    expect(made.id).toBe('g1');
    expect(made).toMatchObject({
      ownerId: 'user-1',
      treeId: 'tree-1',
      projectId: 'project-9',
      title: 'A blue-green deployment lane',
      messages: [],
    });
  });
  it('refuses a branch with no title', async () => {
    const outcome = await run('make_branch', { treeId: 'tree-1' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('title');
    expect(branches).toHaveLength(1);
  });

  it('refuses a branch under a tree that does not exist', async () => {
    const outcome = await run('make_branch', { treeId: 'ghost', title: 'A lane' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('no such tree');
    expect(branches).toHaveLength(1);
  });
});

describe('make_leaf', () => {
  it('grows a proposed, todo leaf under the named branch', async () => {
    const outcome = await run('make_leaf', {
      branchId: 'branch-1',
      title: 'The job queue',
      body: 'A worker pool picks jobs up within a second of them being enqueued, and retries failures three times.',
    });

    expect(outcome.ok).toBe(true);
    expect(leaves[0]).toMatchObject({
      ownerId: 'user-1',
      branchId: 'branch-1',
      title: 'The job queue',
      body: 'A worker pool picks jobs up within a second of them being enqueued, and retries failures three times.',
      column: 'todo',
      status: 'proposed',
      depth: 0,
    });
  });

  it('records leaf-to-leaf dependencies when given, in either spelling', async () => {
    leaves.push({
      id: 'leaf-0',
      ownerId: 'user-1',
      branchId: 'branch-1',
      title: 'Schema first',
      body: 'The jobs collection exists before anything writes to it.',
      column: 'todo',
      status: 'proposed',
      depth: 0,
      blocking: false,
      createdAt: 'now',
      updatedAt: 'now',
    });

    const outcome = await run('make_leaf', { branchId: 'branch-1', title: 'B', body: 'c', depends_on: ['leaf-0'] });

    expect(outcome.ok).toBe(true);
    expect(leaves.at(-1)?.dependsOn).toEqual(['leaf-0']);
  });

  it('insists the goal statement exists — it is what gets judged', async () => {
    const outcome = await run('make_leaf', { branchId: 'branch-1', title: 'No body' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('judge');
    expect(leaves).toHaveLength(0);
  });

  it('refuses a leaf under a branch that does not exist yet', async () => {
    const outcome = await run('make_leaf', { branchId: 'ghost', title: 'A leaf', body: 'a goal' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('no such branch');
    expect(leaves).toHaveLength(0);
  });

  it('refuses outward dependencies on leaves that do not exist', async () => {
    const outcome = await run('make_leaf', { branchId: 'branch-1', title: 'A leaf', body: 'a goal', dependsOn: ['ghost'] });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('do not exist');
    expect(leaves).toHaveLength(0);
  });
});

describe('ready_leaves', () => {
  const leaf = (id: string, status: LeafStatus, extra: Partial<Leaf> = {}): Leaf => ({
    id,
    ownerId: 'user-1',
    branchId: 'branch-1',
    title: `leaf ${id}`,
    body: 'a checkable goal',
    column: 'todo',
    status,
    depth: 0,
    blocking: false,
    createdAt: 'now',
    updatedAt: 'now',
    ...extra,
  });

  const task = (id: string, leafId: string, status: TaskStatus = 'proposed'): Task => ({
    id,
    ownerId: 'user-1',
    leafId,
    title: `task ${id}`,
    doneMeans: 'it is done',
    dependsOn: [],
    status,
    runs: [],
    createdAt: 'now',
    updatedAt: 'now',
  });

  const seedWorld = () => {
    trees.push({ id: 'tree-2', ownerId: 'user-1', name: 'Other', type: 'application', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' });
    branches.push({
      id: 'branch-2',
      ownerId: 'user-1',
      treeId: 'tree-2',
      projectId: 'project-9',
      title: 'The other direction',
      messages: [],
      createdAt: 'now',
      updatedAt: 'now',
    });
    leaves.push(
      leaf('leaf-ready', 'pending'), // no deps, one open task
      leaf('leaf-ready-after-done', 'pending', { dependsOn: ['leaf-done'] }), // dep succeeded
      leaf('leaf-blocked', 'pending', { dependsOn: ['leaf-ready', 'ghost-leaf'] }), // dep pending + unknown
      leaf('leaf-unbroken', 'pending'), // pending but zero tasks
      leaf('leaf-proposed', 'proposed'),
      leaf('leaf-claimed', 'claimed'),
      leaf('leaf-running', 'running'),
      leaf('leaf-done', 'succeeded'),
      leaf('leaf-failed', 'failed'),
      leaf('leaf-other-tree', 'pending', { branchId: 'branch-2' }), // another tree — must not appear
    );
    tasks.push(
      task('task-1', 'leaf-ready'),
      task('task-2', 'leaf-ready', 'dropped'), // settled — does not count
      task('task-3', 'leaf-ready-after-done'),
      task('task-4', 'leaf-done', 'done'),
    );
  };

  it('partitions the tree into ready, unbroken, blocked, notApproved, inFlight and settled', async () => {
    seedWorld();
    const outcome = await run('ready_leaves', { treeId: 'tree-1' });

    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toBe('2 ready, 1 blocked, 1 without tasks, 1 claimed, 1 in flight, 2 settled — tree tree-1');

    const content = JSON.parse(outcome.content as string) as {
      ready: { id: string; taskCount: number }[];
      unbroken: { id: string }[];
      blocked: { id: string; waitingOn: string[] }[];
      notApproved: { id: string }[];
      claimed: { id: string }[];
      inFlight: { id: string }[];
      settled: { id: string; status: string }[];
    };
    expect(content.ready.map((entry) => entry.id)).toEqual(['leaf-ready', 'leaf-ready-after-done']);
    expect(content.ready.find((entry) => entry.id === 'leaf-ready')!.taskCount).toBe(1); // the dropped task does not count
    expect(content.unbroken.map((entry) => entry.id)).toEqual(['leaf-unbroken']);
    expect(content.blocked).toEqual([{ id: 'leaf-blocked', title: 'leaf leaf-blocked', waitingOn: ['leaf-ready', 'ghost-leaf'] }]);
    expect(content.notApproved.map((entry) => entry.id)).toEqual(['leaf-proposed']);
    expect(content.claimed.map((entry) => entry.id)).toEqual(['leaf-claimed']);
    expect(content.inFlight.map((entry) => entry.id)).toEqual(['leaf-running']);
    expect(content.settled).toEqual([
      { id: 'leaf-done', title: 'leaf leaf-done', status: 'succeeded' },
      { id: 'leaf-failed', title: 'leaf leaf-failed', status: 'failed' },
    ]);
  });

  it('never leaks another tree’s leaves into the partition', async () => {
    seedWorld();
    const outcome = await run('ready_leaves', { treeId: 'tree-2' });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('leaf-other-tree');
    const named = JSON.parse(outcome.content as string) as { ready: unknown[]; blocked: unknown[] };
    expect(JSON.stringify(named)).not.toContain('leaf-ready');
  });

  it('refuses a missing treeId and an unknown tree', async () => {
    const missing = await run('ready_leaves', {});
    expect(missing.ok).toBe(false);
    expect(missing.digest).toContain('needs a treeId');

    const unknown = await run('ready_leaves', { treeId: 'tree-9' });
    expect(unknown.ok).toBe(false);
    expect(unknown.digest).toContain('no such tree');
  });
});