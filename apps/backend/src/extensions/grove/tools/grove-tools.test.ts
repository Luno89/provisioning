import type { ActionProposal } from '../../../engine/lib/action-proposals.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createGroveTools } from './grove-tools.js';
import type { Branch, Leaf, LeafStatus } from '../../../projects/lib/leaves.js';
import type { Tree } from '../../../projects/lib/trees.js';
import { type Task, type TaskStatus } from '../../../engine-host/tools/tasks.js';
import type { PlanProposal } from '../../../projects/lib/plan-proposals.js';

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
    title: 'The direction',
    createdAt: 'now',
    updatedAt: 'now',
  }];
  leaves = [];
  tasks = [];
  nextId = 0;
});

describe('ready_leaves', () => {
  const leaf = (id: string, status: LeafStatus, extra: Partial<Leaf> = {}): Leaf => ({
    id,
    ownerId: 'user-1',
    branchId: 'branch-1',
    title: `leaf ${id}`,
    body: 'a checkable goal',
    status,
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

  it('lists the ready leaves in the order the person set: feature by feature, then each feature\'s own order', async () => {
    branches.push({ id: 'branch-first', ownerId: 'user-1', treeId: 'tree-1', title: 'First', priority: 0, createdAt: 'now', updatedAt: 'now' });
    branches[0] = { ...branches[0]!, priority: 1 };
    leaves.push(
      leaf('later', 'pending', { createdAt: '2026-10-01' }),
      leaf('top', 'pending', { priority: 0, createdAt: '2026-10-05' }),
      leaf('first-feature', 'pending', { branchId: 'branch-first' }),
    );
    for (const id of ['later', 'top', 'first-feature']) tasks.push(task(`t-${id}`, id, 'accepted'));
    const outcome = await run('ready_leaves', { treeId: 'tree-1' });
    expect(JSON.parse(outcome.content!).ready.map((entry: { id: string }) => entry.id)).toEqual(['first-feature', 'top', 'later']);
  });

  it('keeps a leaf waiting on its workspace out of the ready ones, saying what it waits for', async () => {
    leaves.push(leaf('parked', 'pending', { waitingFor: { reason: '"task t-parked" waits for the workspace to get dnf jq', since: 't0' } }), leaf('free', 'pending'));
    tasks.push(task('t-parked', 'parked', 'waiting'), task('t-free', 'free', 'accepted'));
    const outcome = await run('ready_leaves', { treeId: 'tree-1' });
    const read = JSON.parse(outcome.content!);
    expect(read.ready.map((entry: { id: string }) => entry.id)).toEqual(['free']);
    expect(read.waitingOnWorkspace).toEqual([{ id: 'parked', title: 'leaf parked', waitingFor: '"task t-parked" waits for the workspace to get dnf jq' }]);
    expect(outcome.digest).toContain('1 waiting on the workspace');
  });

  const seedWorld = () => {
    trees.push({ id: 'tree-2', ownerId: 'user-1', name: 'Other', type: 'application', projectIds: ['project-9'], createdAt: 'now', updatedAt: 'now' });
    branches.push({
      id: 'branch-2',
      ownerId: 'user-1',
      treeId: 'tree-2',
      title: 'The other direction',
      createdAt: 'now',
      updatedAt: 'now',
    });
    leaves.push(
      leaf('leaf-ready', 'pending'), // no deps, one open task
      leaf('leaf-ready-after-done', 'pending', { dependsOn: ['leaf-done'] }), // dep succeeded
      leaf('leaf-blocked', 'pending', { dependsOn: ['leaf-ready', 'ghost-leaf'] }), // dep pending + unknown
      leaf('leaf-unbroken', 'pending'), // pending but zero tasks
      leaf('leaf-claimed', 'claimed'),
      leaf('leaf-running', 'running'),
      leaf('leaf-done', 'succeeded'),
      leaf('leaf-failed', 'failed'),
      leaf('leaf-other-tree', 'pending', { branchId: 'branch-2' }), // another tree — must not appear
    );
    tasks.push(
      task('task-1', 'leaf-ready', 'accepted'),
      task('task-2', 'leaf-ready', 'dropped'), // settled — does not count
      task('task-3', 'leaf-ready-after-done', 'accepted'),
      task('task-4', 'leaf-done', 'done'),
      task('task-5', 'leaf-unbroken', 'proposed'),
    );
  };

  it('partitions the tree into ready, unbroken, blocked, claimed, inFlight and settled', async () => {
    seedWorld();
    const outcome = await run('ready_leaves', { treeId: 'tree-1' });

    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toBe("2 ready, 1 blocked, 1 without tasks, 1 claimed, 0 awaiting a person's review, 0 waiting on the workspace, 1 in flight, 2 settled — tree tree-1");

    const content = JSON.parse(outcome.content as string) as {
      ready: { id: string; taskCount: number }[];
      unbroken: { id: string }[];
      blocked: { id: string; waitingOn: string[] }[];
      claimed: { id: string }[];
      inFlight: { id: string }[];
      settled: { id: string; status: string }[];
    };
    expect(content.ready.map((entry) => entry.id)).toEqual(['leaf-ready', 'leaf-ready-after-done']);
    expect(content.ready.find((entry) => entry.id === 'leaf-ready')!.taskCount).toBe(1); // the dropped task does not count
    expect(content.unbroken.map((entry) => entry.id)).toEqual(['leaf-unbroken']);
    expect(content.blocked).toEqual([{ id: 'leaf-blocked', title: 'leaf leaf-blocked', waitingOn: ['leaf-ready', 'ghost-leaf'] }]);
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

describe('next_leaf_task', () => {
  const leaf = (id: string, extra: Partial<Leaf> = {}): Leaf => ({
    id,
    ownerId: 'user-1',
    branchId: 'branch-1',
    title: `leaf ${id}`,
    body: 'a checkable goal',
    status: 'running',
    createdAt: 'now',
    updatedAt: 'now',
    ...extra,
  });

  const task = (id: string, status: TaskStatus, extra: Partial<Task> = {}): Task => ({
    id,
    ownerId: 'user-1',
    leafId: 'leaf-1',
    title: `task ${id}`,
    doneMeans: 'it is done',
    dependsOn: [],
    status,
    runs: [],
    createdAt: 'now',
    updatedAt: 'now',
    ...extra,
  });

  const next = (parsed: Record<string, unknown>) => run('next_leaf_task', parsed);
  const step = async (parsed: Record<string, unknown>) => JSON.parse((await next(parsed)).content ?? '{}') as { step: string; reason?: string; item?: Record<string, unknown> };

  it('hands over the next task: what it is, what it is for, where the leaf\'s context lives, and who else is in flight', async () => {
    leaves = [leaf('leaf-1')];
    tasks = [task('a', 'accepted', { description: 'write greet.js', role: 'the greeting' }), task('b', 'accepted', { dependsOn: ['a'] })];

    const outcome = await next({ leafId: 'leaf-1', siblings: 'leaf-2 is being worked next door' });

    expect(outcome.ok, outcome.digest).toBe(true);
    expect(outcome.digest).toBe('next: task a');
    expect(JSON.parse(outcome.content ?? '{}')).toEqual({
      step: 'run',
      item: {
        id: 'a',
        title: 'task a',
        doneMeans: 'it is done',
        leafId: 'leaf-1',
        description: 'write greet.js',
        role: 'the greeting',
        siblings: 'leaf-2 is being worked next door',
        context: {
          planDoc: expect.any(String),
          leafBrief: expect.stringContaining('leaf-1'),
          worktree: expect.stringContaining('leaf-1'),
          branch: expect.stringContaining('leaf-1'),
        },
      },
    });
  });

  it('tells the next attempt which one it is and what the last attempt found — counted from the runs on the task, not from a variable', async () => {
    leaves = [leaf('leaf-1')];
    tasks = [task('a', 'failed', { runs: ['run-0'], evidence: 'the test did not pass' })];

    const outcome = await next({ leafId: 'leaf-1' });

    expect(outcome.digest).toBe('next: task a (attempt 2)');
    expect(JSON.parse(outcome.content ?? '{}').item).toMatchObject({ id: 'a', previousAttempt: 'the test did not pass' });
  });

  it('says when the leaf is ready to claim, when it was never broken down, and when it cannot be finished', async () => {
    leaves = [leaf('leaf-1'), leaf('leaf-2'), leaf('leaf-3')];
    tasks = [
      task('a', 'done', { leafId: 'leaf-1' }),
      task('b', 'proposed', { leafId: 'leaf-2' }),
      task('c', 'failed', { leafId: 'leaf-3', runs: ['run-0', 'run-1'], evidence: 'the build is broken' }),
    ];

    expect(await step({ leafId: 'leaf-1' })).toEqual({ step: 'claim' });
    expect(await step({ leafId: 'leaf-2' })).toEqual({ step: 'unbroken' });
    expect((await step({ leafId: 'leaf-3' })).step, 'a failed task is worked again, however often it failed').toBe('run');

    leaves = [...leaves, leaf('leaf-4')];
    tasks = [...tasks, task('d', 'accepted', { leafId: 'leaf-4', dependsOn: ['d'] })];
    const cannot = await step({ leafId: 'leaf-4' });
    expect(cannot.step).toBe('fail');
    expect(cannot.reason).toContain('"task d" can never start');
  });

  it('refuses without a leaf, and for a leaf that is not the caller\'s', async () => {
    leaves = [leaf('leaf-1', { ownerId: 'someone-else' })];

    expect((await next({})).digest).toContain('needs a leafId');
    expect((await next({ leafId: 'leaf-1' })).digest).toContain('no such leaf');
  });
});

describe('claim_leaf', () => {
  const claim = (parsed: Record<string, unknown>) => run('claim_leaf', parsed);

  it('files a claim: the leaf goes claimed, the evidence goes on file for the judge', async () => {
    leaves.push({
      id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a checkable goal', status: 'running',
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

  it('refuses a claim from a run the story was taken off, after it was changed and started again', async () => {
    leaves.push({
      id: 'leaf-r', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a goal', status: 'pending',
      attempts: [{ attempt: 1, error: 'stopped and started again: print it too', failedAt: 'now', runId: 'run-1', change: 'p1' }],
      createdAt: 'now', updatedAt: 'now',
    });
    const outcome = await claim({ leafId: 'leaf-r', result: 'claimed', evidence: 'ran it' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('was taken off this run (stopped and started again: print it too)');
    expect(leaves.find((leaf) => leaf.id === 'leaf-r')!.status).toBe('pending');
  });

  it('never lets the work grade itself — a success word is refused with the teaching', async () => {
    leaves.push({
      id: 'leaf-2', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a goal', status: 'running',
      createdAt: 'now', updatedAt: 'now',
    });
    const outcome = await claim({ leafId: 'leaf-2', result: 'succeeded', evidence: 'it works' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain("can't claim a leaf as succeeded");
    expect(leaves.find((leaf) => leaf.id === 'leaf-2')!.status).toBe('running');
  });

  it('a failed claim needs a reason, and carries the evidence forward for the replan', async () => {
    leaves.push({
      id: 'leaf-3', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a goal', status: 'running',
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
    for (const status of ['claimed', 'succeeded', 'failed'] as const) {
      leaves.push({
        id: `leaf-${status}`, ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'a goal', status,
        createdAt: 'now', updatedAt: 'now',
      });
      const outcome = await claim({ leafId: `leaf-${status}`, result: 'claimed', evidence: 'ran it' });
      expect(outcome.ok, status).toBe(false);
    }
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
    status,
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
    for (const status of ['pending', 'running', 'succeeded', 'cancelled'] as const) {
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
    id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'the end state', status, createdAt: 'now', updatedAt: 'now', ...over,
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

describe('describe_tree_type', () => {
  const withDescriptions = () => createGroveTools({
    stores: {
      trees: { list: async () => trees, save: async () => undefined },
      branches: { list: async () => branches, save: async () => undefined },
      leaves: { list: async () => leaves, save: async () => undefined },
      describeTreeType: async (_ownerId: string, type: string) => (type === 'odoo-addons' ? 'Odoo addons (odoo-addons): …\n\nTHE PLATFORM DOES THESE, SO NEVER PLAN THEM\n- deploying or releasing' : undefined),
    },
  });

  it('hands the planner what a tree of that type becomes', async () => {
    const outcome = await withDescriptions()['describe_tree_type']!({ name: 'describe_tree_type', parsed: { type: 'odoo-addons' }, driver: undefined, caller });
    expect(outcome).toMatchObject({ ok: true, digest: 'odoo-addons described', content: expect.stringContaining('- deploying or releasing') });
  });

  it('refuses a type that is not the person\'s, or none at all, pointing at list_tree_types', async () => {
    expect(await withDescriptions()['describe_tree_type']!({ name: 'describe_tree_type', parsed: { type: 'nope' }, driver: undefined, caller })).toMatchObject({ ok: false, digest: 'there is no tree type "nope" — list_tree_types gives the ids' });
    expect(await withDescriptions()['describe_tree_type']!({ name: 'describe_tree_type', parsed: {}, driver: undefined, caller })).toMatchObject({ ok: false, digest: expect.stringContaining('name the tree type') });
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
    id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'the end state', status: 'pending', createdAt: 'now', updatedAt: 'now',
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

  it('records the files the leaf\'s branch added or changed since it left main, so the leaf page can open them', async () => {
    leaves = [pending()];
    const outcome = await claimWith(driverWith({
      'git status': { stdout: '' },
      'git rev-parse HEAD': { stdout: 'c0ffee1234567890' },
      'git -c core.quotePath=false diff --name-only --diff-filter=d main...HEAD': { stdout: 'src/health.ts\nnotes/why.md\n' },
    }));

    expect(outcome).toMatchObject({ ok: true });
    expect(leaves[0]!.claim).toMatchObject({ commit: 'c0ffee1234567890', files: ['src/health.ts', 'notes/why.md'] });
  });

  it('records no files when the branch changed nothing, or there is no main to compare with', async () => {
    leaves = [pending()];
    await claimWith(driverWith({ 'git status': { stdout: '' }, 'git rev-parse HEAD': { stdout: 'c0ffee' }, 'git -c core.quotePath': { stdout: '', exitCode: 128 } }));

    expect(leaves[0]!.claim?.files).toBeUndefined();
  });

  it('refuses while work is uncommitted, and names it', async () => {
    leaves = [pending()];
    const outcome = await claimWith(driverWith({ 'git status': { stdout: ' M site/index.html\n?? notes.txt' } }));

    expect(outcome).toMatchObject({ ok: false, digest: expect.stringContaining('uncommitted changes (M site/index.html; ?? notes.txt)') });
    expect(leaves[0]!.status).toBe('pending');
  });
});

describe('a claim the judge kept for a person', () => {
  const claimedLeaf = (): Leaf => ({
    id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'A leaf', body: 'the end state', status: 'claimed', createdAt: 'now', updatedAt: 'now',
    claim: { evidence: 'ran it', at: '2025-12-31T00:00:00.000Z' },
  });

  it('leaves the judge pass and waits for a person, with the judge\'s note', async () => {
    leaves = [claimedLeaf()];
    await run('settle_leaf', { leafId: 'leaf-1', verdict: 'stay-claimed', note: 'the port was never probed' });

    const partition = JSON.parse((await run('ready_leaves', { treeId: 'tree-1' })).content ?? '{}') as { claimed: unknown[]; awaitingReview: unknown[] };
    expect(partition.claimed).toEqual([]);
    expect(partition.awaitingReview).toEqual([{ id: 'leaf-1', title: 'A leaf', review: 'the port was never probed' }]);
  });

  it('is still settleable, and a verdict takes it out of review', async () => {
    leaves = [claimedLeaf()];
    await run('settle_leaf', { leafId: 'leaf-1', verdict: 'stay-claimed', note: 'thin' });
    const outcome = await run('settle_leaf', { leafId: 'leaf-1', verdict: 'verified', note: 'checked by hand' });

    expect(outcome.ok).toBe(true);
    expect(leaves[0]).toMatchObject({ status: 'succeeded', verified: true });
  });
});


describe('a conversation about one tree', () => {
  const PLAN = {
    planDoc: '# More\n\n## Destination\nbye.txt exists.\n\n## Not yet specified\nNone\n\n## Out of scope\nNone',
    branches: [{ title: 'More', leaves: [{ key: 'bye', title: 'Bye', body: 'bye.txt says bye', brief: 'Write bye.txt.', dependsOn: ['leaf-1'], tasks: [] }] }],
  };
  let saved: PlanProposal[] = [];
  const bound = (_conversationId: string) => createGroveTools({
    stores: {
      trees: { list: async () => trees, save: async () => undefined },
      branches: { list: async () => branches, save: async () => undefined },
      leaves: { list: async () => leaves, save: async () => undefined },
      tasks: { list: async () => tasks },
      plans: { save: async (entry) => { saved = [...saved.filter((e) => e.id !== entry.id), entry]; }, list: async () => saved },
      treeTypes: async () => [{ id: 'application', label: 'App', summary: 'an app' }],
      binding: async (ownerId, id) => (ownerId !== 'user-1' ? undefined : id === 'conv-tree' ? { treeId: 'tree-1' } : id === 'conv-project' ? { projectId: 'project-9' } : {}),
    },
    newId: () => `g${++nextId}`,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const call = (conversationId: string, name: string, parsed: Record<string, unknown>) =>
    bound(conversationId)[name]!({ name, parsed, driver: undefined, caller: { ...caller, conversationId } });

  beforeEach(() => {
    saved = [];
    leaves = [{ id: 'leaf-1', ownerId: 'user-1', branchId: 'branch-1', title: 'Hello', body: 'hello.txt says hello', status: 'succeeded', createdAt: 'now', updatedAt: 'now' }];
  });

  it('writes the proposed plan into the conversation\'s workspace and hands it back to link, only when it works in one', async () => {
    const files: Record<string, string> = {};
    const driver = { writeFile: async (path: string, content: string) => { files[path] = content; } } as never;
    const tools = bound('conv-free');
    const fresh = { ...PLAN, tree: { name: 'New', type: 'application', goal: 'x' }, branches: [{ title: 'More', leaves: [{ ...PLAN.branches[0]!.leaves[0]!, dependsOn: [] }] }] };

    const outcome = await tools['propose_plan']!({ name: 'propose_plan', parsed: fresh, driver, caller: { ...caller, conversationId: 'conv-free', runId: 'run-p', agentSlug: 'planner', inConversationWorkspace: true } });

    expect(outcome).toMatchObject({ ok: true, artifacts: [{ kind: 'file', path: '/work/planner/run-p/plan.md' }] });
    expect(outcome.content).toContain('also written to /work/planner/run-p/plan.md');
    expect(files['/work/planner/run-p/plan.md']).toContain('## Destination');
    expect(files['/work/planner/run-p/plan.md']).toContain('- **Bye** (`bye`): bye.txt says bye');

    const elsewhere = await tools['propose_plan']!({ name: 'propose_plan', parsed: fresh, driver, caller: { ...caller, conversationId: 'conv-free', runId: 'run-q', agentSlug: 'planner' } });
    expect(elsewhere.artifacts).toBeUndefined();
    expect(Object.keys(files)).toEqual(['/work/planner/run-p/plan.md']);
  });

  it('still proposes when the plan cannot be written, and says so', async () => {
    const driver = { writeFile: async () => { throw new Error('the workspace is full'); } } as never;
    const fresh = { ...PLAN, tree: { name: 'New', type: 'application', goal: 'x' }, branches: [{ title: 'More', leaves: [{ ...PLAN.branches[0]!.leaves[0]!, dependsOn: [] }] }] };

    const outcome = await bound('conv-free')['propose_plan']!({ name: 'propose_plan', parsed: fresh, driver, caller: { ...caller, conversationId: 'conv-free', runId: 'run-p', agentSlug: 'planner', inConversationWorkspace: true } });

    expect(outcome.ok).toBe(true);
    expect(outcome.artifacts).toBeUndefined();
    expect(outcome.content).toContain('Writing it to /work/planner/run-p/plan.md failed: the workspace is full');
  });

  it('grows the bound tree when the plan names none', async () => {
    const outcome = await call('conv-tree', 'propose_plan', PLAN);
    expect(outcome.ok, outcome.digest).toBe(true);
    expect(saved[0]?.plan?.treeId).toBe('tree-1');
    expect(saved[0]?.plan?.branches[0]?.leaves[0]?.dependsOn).toEqual(['leaf-1']);
  });

  it('refuses a new tree or another tree, and saves nothing', async () => {
    const fresh = await call('conv-tree', 'propose_plan', { ...PLAN, tree: { name: 'Other', type: 'application', goal: 'x' } });
    expect(fresh.ok).toBe(false);
    expect(fresh.digest).toContain('grows it — send treeId tree-1');
    trees.push({ ...trees[0]!, id: 'tree-2' });
    const elsewhere = await call('conv-tree', 'propose_plan', { ...PLAN, treeId: 'tree-2' });
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.digest).toContain('grows that tree, not tree-2');
    expect(saved).toEqual([]);
  });

  it('leaves a conversation about no tree free to start one', async () => {
    const outcome = await call('conv-free', 'propose_plan', { ...PLAN, tree: { name: 'New', type: 'application', goal: 'x' }, branches: [{ title: 'More', leaves: [{ ...PLAN.branches[0]!.leaves[0]!, dependsOn: [] }] }] });
    expect(outcome.ok, outcome.digest).toBe(true);
    expect(saved[0]?.plan?.tree?.name).toBe('New');
  });

  it('marks a new tree planned in a conversation about a project for linking to it, and only a new one', async () => {
    const fresh = await call('conv-project', 'propose_plan', { ...PLAN, tree: { name: 'New', type: 'application', goal: 'x' }, branches: [{ title: 'More', leaves: [{ ...PLAN.branches[0]!.leaves[0]!, dependsOn: [] }] }] });
    expect(fresh.ok, fresh.digest).toBe(true);
    expect(saved.at(-1)?.projectId).toBe('project-9');
    const grow = await call('conv-project', 'propose_plan', { ...PLAN, treeId: 'tree-1' });
    expect(grow.ok, grow.digest).toBe(true);
    expect(saved.find((entry) => entry.status === 'proposed')?.projectId).toBeUndefined();
  });

  it('reads the bound tree without being told which, and refuses another owner\'s', async () => {
    const outcome = await call('conv-tree', 'read_tree', {});
    expect(outcome.ok, outcome.digest).toBe(true);
    expect(outcome.content).toContain('Tree "The app" (tree-1)');
    expect(outcome.content).toContain('(leaf-1) [succeeded');
    trees.push({ ...trees[0]!, id: 'tree-x', ownerId: 'someone-else' });
    expect((await call('conv-free', 'read_tree', { treeId: 'tree-x' })).ok).toBe(false);
    expect((await call('conv-free', 'read_tree', {})).digest).toContain('needs the treeId');
  });
});

describe('growing a tree from a conversation', () => {
  const leaf = (id: string, status: LeafStatus): Leaf => ({ id, ownerId: 'user-1', branchId: 'branch-1', title: `leaf ${id}`, body: 'goal', status, createdAt: 'now', updatedAt: 'now' });
  const growing = (start: () => Promise<{ started: true } | { started: false; reason: 'unavailable' | 'running' | 'switched-off' }>, state = 'none') => {
    const started: string[] = [];
    const made = createGroveTools({
      stores: {
        trees: { list: async () => trees, save: async () => undefined },
        branches: { list: async () => branches, save: async () => undefined },
        leaves: { list: async () => leaves, save: async () => undefined },
        tasks: { list: async () => tasks },
        growing: { start: async (ownerId, treeId) => { started.push(`${ownerId} ${treeId}`); return start(); }, status: async () => ({ state, startedAt: '2026-10-09T20:00:00Z' }) },
      },
    });
    const call = (name: string, parsed: Record<string, unknown>) => made[name]!({ name, parsed, driver: undefined, caller });
    return { call, started };
  };

  it('starts a tree with work waiting, and says it started rather than that it is done', async () => {
    leaves = [leaf('l1', 'pending'), leaf('l2', 'succeeded')];
    const { call, started } = growing(async () => ({ started: true }));
    const outcome = await call('run_tree', { treeId: 'tree-1' });
    expect(outcome).toMatchObject({ ok: true, digest: 'The app is growing' });
    expect(started).toEqual(['user-1 tree-1']);
  });

  it('says a tree already growing is, and starts nothing new', async () => {
    leaves = [leaf('l1', 'running')];
    expect(await growing(async () => ({ started: false, reason: 'running' })).call('run_tree', { treeId: 'tree-1' })).toMatchObject({ ok: true, content: 'The app is already growing; nothing new was started.' });
  });

  it('refuses a tree with nothing planned, one with nothing left, and one whose grower is switched off, saying what to do', async () => {
    leaves = [];
    expect((await growing(async () => ({ started: true })).call('run_tree', { treeId: 'tree-1' })).digest).toContain('has nothing planned yet');
    leaves = [leaf('l1', 'succeeded'), leaf('l2', 'failed')];
    expect((await growing(async () => ({ started: true })).call('run_tree', { treeId: 'tree-1' })).digest).toContain('has nothing left to work');
    leaves = [leaf('l1', 'pending')];
    expect((await growing(async () => ({ started: false, reason: 'switched-off' })).call('run_tree', { treeId: 'tree-1' })).digest).toContain('switched off');
    expect((await growing(async () => ({ started: true })).call('run_tree', { treeId: 'tree-x' })).digest).toBe('no such tree: tree-x');
  });

  it('says in read_tree whether the tree is growing', async () => {
    leaves = [leaf('l1', 'running')];
    expect((await growing(async () => ({ started: true }), 'running').call('read_tree', { treeId: 'tree-1' })).content).toContain('It is growing now, since 2026-10-09T20:00:00Z.');
    expect((await growing(async () => ({ started: true }), 'none').call('read_tree', { treeId: 'tree-1' })).content).toContain('It is not growing.');
  });
});

describe('choosing a tree\'s models from a conversation', () => {
  const choosing = () => {
    const saved: ActionProposal[] = [];
    const made = createGroveTools({
      stores: {
        trees: { list: async () => trees, save: async () => undefined },
        branches: { list: async () => branches, save: async () => undefined },
        leaves: { list: async () => leaves, save: async () => undefined },
        models: {
          describe: async () => 'Models in this tree\'s work:\n- Executor (executor): its own, Tabby (id tabby)',
          problem: async (_owner, _tree, agent, modelId) => (agent !== 'executor' ? { error: `${agent} asks no model anything in this tree's work, so it has no model to choose` } : modelId === 'nope' ? { error: 'There is no model nope among yours' } : undefined),
        },
        actions: { list: async () => saved, save: async (proposal) => { saved.push(proposal); } },
      },
      newId: () => 'card-1',
      now: () => 'now',
    });
    const call = (name: string, parsed: Record<string, unknown>) => made[name]!({ name, parsed, driver: undefined, caller });
    return { call, saved };
  };

  it('lists the tree\'s models in read_tree, and puts a choice on a card once', async () => {
    const { call, saved } = choosing();
    expect((await call('read_tree', { treeId: 'tree-1' })).content).toContain('- Executor (executor): its own, Tabby (id tabby)');
    expect(await call('propose_tree_model', { treeId: 'tree-1', agent: 'executor', model: 'vllm', why: 'faster' })).toMatchObject({ ok: true, content: 'Proposed on a card: Work executor\'s part of The app on vllm. Nothing changes until the person applies it.' });
    expect(saved).toMatchObject([{ id: 'card-1', kind: 'set_tree_model', params: { treeId: 'tree-1', agent: 'executor', modelId: 'vllm' }, why: 'faster', status: 'proposed' }]);
    expect((await call('propose_tree_model', { treeId: 'tree-1', agent: 'executor', model: 'vllm', why: 'faster' })).content).toContain('already waiting');
    expect(saved).toHaveLength(1);
  });

  it('refuses what cannot be chosen, and proposes nothing', async () => {
    const { call, saved } = choosing();
    expect((await call('propose_tree_model', { treeId: 'tree-1', agent: 'grove', model: 'vllm', why: 'x' })).digest).toBe('grove asks no model anything in this tree\'s work, so it has no model to choose; nothing was proposed');
    expect((await call('propose_tree_model', { treeId: 'tree-1', agent: 'executor', model: 'nope', why: 'x' })).digest).toBe('There is no model nope among yours; nothing was proposed');
    expect((await call('propose_tree_model', { treeId: 'tree-1', agent: 'executor', why: 'x' })).digest).toBe('name the model, or set clear to put the agent back on its own');
    expect((await call('propose_tree_model', { treeId: 'tree-x', agent: 'executor', model: 'vllm', why: 'x' })).digest).toBe('no such tree: tree-x');
    expect(saved).toEqual([]);
  });
});

describe('proposing changes to stories and features from their chats', () => {
  let plans: PlanProposal[] = [];
  const bound: Record<string, { treeId?: string; leafId?: string; branchId?: string }> = {
    'story-chat': { treeId: 'tree-1', leafId: 'leaf-a' },
    'feature-chat': { treeId: 'tree-1', branchId: 'branch-1' },
  };
  const changeTools = () => createGroveTools({
    stores: {
      trees: { list: async () => trees, save: async () => {} },
      branches: { list: async () => branches, save: async () => {} },
      leaves: { list: async () => leaves, save: async () => {} },
      tasks: { list: async () => tasks },
      plans: {
        save: async (proposal) => { plans = [...plans.filter((entry) => entry.id !== proposal.id), proposal]; },
        list: async (_ownerId, conversationId) => plans.filter((entry) => !conversationId || entry.conversationId === conversationId),
      },
      binding: async (_ownerId, conversationId) => bound[conversationId],
    },
    newId: () => `c${++nextId}`,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  const say = (name: string, parsed: Record<string, unknown>, conversationId: string) =>
    changeTools()[name]!({ name, parsed, driver: undefined, caller: { ...caller, agentSlug: 'koala', conversationId } });
  const story = (id: string, status: LeafStatus): Leaf => ({ id, ownerId: 'user-1', branchId: 'branch-1', title: `Story ${id}`, body: 'a goal', status, createdAt: 'now', updatedAt: 'now' });

  beforeEach(() => {
    plans = [];
    leaves = [story('leaf-a', 'running'), story('leaf-b', 'succeeded')];
  });

  it('proposes a change to the story its chat is about, says what approving does, and replaces an earlier one', async () => {
    const first = await say('propose_story_change', { why: 'print it too', body: 'On screen and on paper' }, 'story-chat');
    expect(first.ok).toBe(true);
    expect(first.content).toContain('The worker on it now is stopped');
    const second = await say('propose_story_change', { why: 'print it too', body: 'On screen, on paper and by mail' }, 'story-chat');
    expect(second.content).toContain('replaces the change proposed earlier');
    expect(plans.map((entry) => [entry.status, entry.change?.edit?.body])).toEqual([['superseded', 'On screen and on paper'], ['proposed', 'On screen, on paper and by mail']]);
    expect(plans[1]).toMatchObject({ conversationId: 'story-chat', runId: 'run-1' });
  });

  it('refuses changing a shipped story and points at a follow-up, which goes in its feature waiting on it', async () => {
    const refused = await say('propose_story_change', { leafId: 'leaf-b', why: 'w', body: 'new' }, 'feature-chat');
    expect(refused.ok).toBe(false);
    expect(refused.digest).toContain('propose_stories, waiting on leaf-b');
    const followUp = await say('propose_stories', { why: 'mail it too', stories: [{ title: 'Mailed note', body: 'The order email shows the note', brief: 'Inherit the mail template.', dependsOn: ['leaf-b'] }] }, 'story-chat');
    expect(followUp.ok).toBe(true);
    expect(plans[0]!.change?.add).toMatchObject({ branchId: 'branch-1', branchTitle: 'The direction' });
  });

  it('cancels the story its chat is about, and needs a story when the chat is about none', async () => {
    expect((await say('propose_story_cancel', { why: 'not wanted' }, 'story-chat')).digest).toContain('Cancel “Story leaf-a”');
    expect((await say('propose_story_cancel', { why: 'not wanted' }, 'feature-chat')).digest).toContain('say which stories to cancel');
  });
});
