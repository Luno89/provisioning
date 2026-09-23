import { describe, it, expect, beforeEach } from 'vitest';
import { createGroveTools } from './grove-tools.js';
import type { Branch, Leaf } from '../../lib/leaves.js';
import type { Tree } from '../../lib/trees.js';

let trees: Tree[] = [];
let branches: Branch[] = [];
let leaves: Leaf[] = [];
let nextId = 0;

const tools = () => createGroveTools({
  stores: {
    trees: { list: async () => trees, save: async (tree) => { trees = [tree]; } },
    branches: { list: async () => branches, save: async (branch) => { branches.push(branch); } },
    leaves: { list: async () => leaves, save: async (leaf) => { leaves.push(leaf); } },
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