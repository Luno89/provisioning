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
    leaves: {
      list: async () => leaves,
      save: async (leaf) => {
        leaves = leaves.filter((existing) => existing.id !== leaf.id);
        leaves.push(leaf);
      },
    },
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
describe('claim_leaf', () => {
  const claim = (parsed: Record<string, unknown>) => run('claim_leaf', parsed);

  it('files a claim: the leaf goes claimed, the evidence goes on file for the judge', async () => {
    leaves.push({
      id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a checkable goal',
      column: 'todo', status: 'running', depth: 0, blocking: false,
      createdAt: 'now', updatedAt: 'now',
    });
    const outcome = await claim({
      leafId: 'leaf-1',
      result: 'claimed',
      evidence: 'ran `node server.js` — listening on :3000; config at /app/config.json; run r7',
      runs: ['r7'],
      findings: 'health endpoint flaky under load',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toBe('claimed leaf-1');
    const saved = leaves.find((leaf) => leaf.id === 'leaf-1')!;
    expect(saved.status).toBe('claimed');
    expect(saved.claim).toMatchObject({
      evidence: expect.stringContaining('listening on :3000'),
      findings: 'health endpoint flaky under load',
      runs: ['r7'],
    });
  });

  it('never lets the work grade itself — a success word is refused with the teaching', async () => {
    leaves.push({
      id: 'leaf-2', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a goal',
      column: 'todo', status: 'running', depth: 0, blocking: false,
      createdAt: 'now', updatedAt: 'now',
    });
    const outcome = await claim({ leafId: 'leaf-2', result: 'succeeded', evidence: 'it works' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain("can't claim a leaf as succeeded");
    expect(leaves.find((leaf) => leaf.id === 'leaf-2')!.status).toBe('running');
  });

  it('a failed claim needs a reason, and carries the evidence forward for the replan', async () => {
    leaves.push({
      id: 'leaf-3', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a goal',
      column: 'todo', status: 'running', depth: 0, blocking: false,
      createdAt: 'now', updatedAt: 'now',
    });
    const bare = await claim({ leafId: 'leaf-3', result: 'failed', evidence: 'tried the build' });
    expect(bare.ok).toBe(false);
    expect(bare.digest).toContain('needs a reason');

    const failed = await claim({
      leafId: 'leaf-3', result: 'failed',
      evidence: 'tried the build',
      reason: 'build needs the private registry, which this workspace cannot reach',
    });
    expect(failed.ok).toBe(true);
    expect(failed.digest).toContain('failed leaf-3');
    const saved = leaves.find((leaf) => leaf.id === 'leaf-3')!;
    expect(saved.status).toBe('failed');
    expect(saved.findings).toContain('private registry');
    expect(saved.claim!.evidence).toContain('tried the build');
  });

  it('refuses the wrong states with the state and what comes next', async () => {
    for (const status of ['proposed', 'claimed', 'succeeded', 'failed'] as const) {
      leaves.push({
        id: `leaf-${status}`, ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a goal',
        column: 'todo', status, depth: 0, blocking: false,
        createdAt: 'now', updatedAt: 'now',
      });
      const outcome = await claim({ leafId: `leaf-${status}`, result: 'claimed', evidence: 'ran it' });
      expect(outcome.ok, status).toBe(false);
    }
    expect((await claim({ leafId: 'leaf-proposed', result: 'claimed', evidence: 'ran it' })).digest).toContain('not accepted yet');
    expect((await claim({ leafId: 'leaf-claimed', result: 'claimed', evidence: 'ran it' })).digest).toContain('already claimed');
    expect((await claim({ leafId: 'leaf-succeeded', result: 'claimed', evidence: 'ran it' })).digest).toContain('already settled');
    const ghost = await claim({ leafId: 'leaf-ghost', result: 'claimed', evidence: 'ran it' });
    expect(ghost.ok).toBe(false);
    expect(ghost.digest).toContain('no such leaf');
  });
});

describe('settle_leaf', () => {
  const claimedLeaf = (id: string, status: LeafStatus, withClaim = true): Leaf => ({
    id,
    ownerId: 'user-1',
    branchId: 'branch-1',
    title: 'A leaf',
    body: 'the server answers :3000/health',
    column: 'todo',
    status,
    depth: 0,
    blocking: false,
    createdAt: 'now',
    updatedAt: 'now',
    ...(withClaim && status === 'claimed'
      ? { claim: { evidence: 'ran curl :3000/health — 200 OK; server log at /app/server.log', at: 'now' } }
      : {}),
  });
  const settle = (parsed: Record<string, unknown>) => run('settle_leaf', parsed);

  it('verifies a claim the evidence demonstrates: the leaf is succeeded and verified', async () => {
    leaves.push(claimedLeaf('leaf-j1', 'claimed'));
    const outcome = await settle({ leafId: 'leaf-j1', verdict: 'verified' });

    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toBe('settled leaf-j1 — verified');
    const saved = leaves.find((leaf) => leaf.id === 'leaf-j1')!;
    expect(saved.status).toBe('succeeded');
    expect(saved.verified).toBe(true);
    expect(saved.claim).toBeDefined(); // the claim stays on file as the trace of the verdict
  });

  it('keeps a thin claim claimed, with the thinness on file for the next judge or person', async () => {
    leaves.push(claimedLeaf('leaf-j2', 'claimed'));
    const outcome = await settle({
      leafId: 'leaf-j2',
      verdict: 'stay-claimed',
      note: 'the health endpoint answered once under load; two more load samples needed before this is demonstrated',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toContain('kept leaf-j2 claimed');
    const saved = leaves.find((leaf) => leaf.id === 'leaf-j2')!;
    expect(saved.status).toBe('claimed'); // stayed — not promoted, not re-run
    expect(saved.review).toMatchObject({ verdict: 'concern', reason: expect.stringContaining('two more load samples') });
  });

  it('fails a claim whose evidence shows the goal was not reached', async () => {
    leaves.push(claimedLeaf('leaf-j3', 'claimed'));
    const bare = await settle({ leafId: 'leaf-j3', verdict: 'failed' });
    expect(bare.ok).toBe(false);
    expect(bare.digest).toContain('needs a reason');

    const failed = await settle({
      leafId: 'leaf-j3',
      verdict: 'failed',
      note: 'the endpoint answered 200, but on a mock — the real wiring the goal names is absent',
    });
    expect(failed.ok).toBe(true);
    expect(failed.digest).toBe('settled leaf-j3 — failed');
    const saved = leaves.find((leaf) => leaf.id === 'leaf-j3')!;
    expect(saved.status).toBe('failed');
    expect(saved.findings).toContain('on a mock');
  });

  it('settles claims only — raw, unclaimed, or finished leaves are refused', async () => {
    for (const status of ['proposed', 'pending', 'running', 'succeeded', 'cancelled'] as const) {
      leaves.push(claimedLeaf(`leaf-${status}`, status, false));
      const outcome = await settle({ leafId: `leaf-${status}`, verdict: 'verified' });
      expect(outcome.ok, status).toBe(false);
      expect(outcome.digest).toContain('not awaiting judgment');
    }
    const ghost = await settle({ leafId: 'leaf-ghost', verdict: 'verified' });
    expect(ghost.ok).toBe(false);
    expect(ghost.digest).toContain('no such leaf');
  });
});

describe('another owner\'s grove', () => {
  const stranger = { ownerId: 'user-2', runId: 'run-9', agentSlug: 'planner' };
  const as = (name: string, parsed: Record<string, unknown>) => tools()[name]!({ name, parsed, driver: undefined, caller: stranger });
  const leafOf = (status: LeafStatus, over: Partial<Leaf> = {}): Leaf => ({
    id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'the end state',
    column: 'todo', status, depth: 0, blocking: false, createdAt: 'now', updatedAt: 'now', ...over,
  });

  it('cannot branch it, grow a leaf on it, or hang a leaf off its leaves', async () => {
    leaves = [leafOf('pending')];
    tasks = [];

    const branched = await as('make_branch', { treeId: 'tree-1', title: 'A lane' });
    const grown = await as('make_leaf', { branchId: 'branch-1', title: 'A leaf', body: 'an end state' });

    expect(branched).toMatchObject({ ok: false, digest: expect.stringContaining('no such tree') });
    expect(grown).toMatchObject({ ok: false, digest: expect.stringContaining('no such branch') });
    expect(branches).toHaveLength(1);
    expect(leaves).toHaveLength(1);
  });

  it('cannot claim, settle or schedule it, and learns nothing about it', async () => {
    leaves = [leafOf('pending')];
    const claim = await as('claim_leaf', { leafId: 'leaf-1', result: 'claimed', evidence: 'ran it' });
    leaves = [leafOf('claimed', { claim: { evidence: 'ran it', at: 'now' } })];
    const settle = await as('settle_leaf', { leafId: 'leaf-1', verdict: 'verified' });
    const schedule = await as('ready_leaves', { treeId: 'tree-1' });

    expect(claim).toMatchObject({ ok: false, digest: 'no such leaf: leaf-1' });
    expect(settle).toMatchObject({ ok: false, digest: 'no such leaf: leaf-1' });
    expect(schedule).toMatchObject({ ok: false, digest: expect.stringContaining('no such tree: tree-1') });
    expect(leaves[0]!.status).toBe('claimed');
  });
});

describe('list_tree_types', () => {
  it('names the kinds of tree the caller can start, with what each is for', async () => {
    const withTypes = createGroveTools({
      stores: {
        trees: { list: async () => trees, save: async () => undefined },
        branches: { list: async () => branches, save: async () => undefined },
        leaves: { list: async () => leaves, save: async () => undefined },
        treeTypes: async () => [{ id: 'api-service', label: 'API service', summary: 'A deployable HTTP API' }],
      },
    });
    const outcome = await withTypes['list_tree_types']!({ name: 'list_tree_types', parsed: {}, driver: undefined, caller });

    expect(outcome).toMatchObject({ ok: true, content: 'The tree types a new tree can be:\n- api-service — API service: A deployable HTTP API' });
  });

  it('says so when there are none', async () => {
    expect(await run('list_tree_types', {})).toMatchObject({ ok: false, digest: expect.stringContaining('no tree types') });
  });
});

describe('claim_leaf in a worktree', () => {
  const driverWith = (outputs: Record<string, { stdout: string; exitCode?: number }>) => ({
    exec: async ({ command }: { command: string }) => {
      const found = Object.entries(outputs).find(([prefix]) => command.startsWith(prefix))?.[1];
      return { stdout: found?.stdout ?? '', stderr: '', exitCode: found?.exitCode ?? 0 };
    },
  }) as never;
  const pending = (): Leaf => ({
    id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'the end state',
    column: 'todo', status: 'pending', depth: 0, blocking: false, createdAt: 'now', updatedAt: 'now',
  });
  const claimWith = (driver: never) => tools()['claim_leaf']!({
    name: 'claim_leaf', parsed: { leafId: 'leaf-1', result: 'claimed', evidence: 'ran it' }, driver, caller,
  });

  it('records the commit the judge will check out', async () => {
    leaves = [pending()];
    const outcome = await claimWith(driverWith({ 'git status': { stdout: '' }, 'git rev-parse HEAD': { stdout: 'c0ffee1234567890' } }));

    expect(outcome).toMatchObject({ ok: true, digest: 'claimed leaf-1 at c0ffee123456' });
    expect(leaves[0]!.claim).toMatchObject({ commit: 'c0ffee1234567890' });
  });

  it('refuses while work is uncommitted, and names it', async () => {
    leaves = [pending()];
    const outcome = await claimWith(driverWith({ 'git status': { stdout: ' M site/index.html\n?? notes.txt' } }));

    expect(outcome).toMatchObject({ ok: false, digest: expect.stringContaining('uncommitted changes (M site/index.html; ?? notes.txt)') });
    expect(leaves[0]!.status).toBe('pending');
  });
});

