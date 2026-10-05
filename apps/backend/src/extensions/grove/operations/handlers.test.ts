import { describe, it, expect, beforeEach } from 'vitest';
import { PROCEDURE_SCHEMA, type NodeRequest, type Procedure } from '@koala/agent-engine/procedure';
import { agentsReachable, createGroveOperations, type GroveOperationDeps } from './handlers.js';
import type { Leaf, Branch } from '../../../lib/leaves.js';
import type { Tree } from '../../../lib/trees.js';
import type { Task } from '../../../engine-host/tools/tasks.js';
import type { PlanProposal } from '../../../lib/plan-proposals.js';

const SANDBOX = { kind: 'sandbox', id: 'engine-tree-t1', workspace: { runId: 'tree-t1' }, capabilities: { kind: 'sandbox', lifecycle: 'invocation' } } as const;

let trees: Tree[];
let branches: Branch[];
let leaves: Leaf[];
let tasks: Task[];
let plans: PlanProposal[];
let commands: { worktree?: string | undefined; command: string }[];
let written: { worktree?: string | undefined; path: string; content: string }[];
let described: { treeId: string; agents?: readonly string[] | undefined }[];
let parked: string[];
let procedures: Record<string, Procedure>;
let dirty: boolean;
let saves: string[];
let saveFails: string | undefined;
let emitted: unknown[];

const leaf = (id: string, over: Partial<Leaf> = {}): Leaf => ({
  id, ownerId: 'user-1', branchId: 'b1', title: `leaf ${id}`, body: `${id} works`, status: 'pending', createdAt: 'then', updatedAt: 'then', ...over,
} as Leaf);

const task = (id: string, leafId: string, over: Partial<Task> = {}): Task => ({
  id, ownerId: 'user-1', leafId, title: `task ${id}`, doneMeans: 'it is done', dependsOn: [], status: 'accepted', runs: [], createdAt: 'then', updatedAt: 'then', ...over,
});

const place = (id: string, kind: string, settings: Record<string, unknown>) => ({ id, kind, settings, position: { x: 0, y: 0 } });
const procedureNaming = (id: string, nodes: ReturnType<typeof place>[]): Procedure => ({
  schema: PROCEDURE_SCHEMA, id, version: '1', name: id, describe: id, budget: {}, start: nodes[0]!.id, nodes, wires: [], flow: [], groups: [],
});

const deps = (): GroveOperationDeps => ({
  trees: { list: async () => trees },
  branches: { list: async () => branches },
  leaves: { list: async () => leaves, save: async (saved) => { leaves = leaves.map((entry) => (entry.id === saved.id ? saved : entry)); } },
  tasks: { list: async (ownerId) => tasks.filter((entry) => entry.ownerId === ownerId), save: async (saved) => { tasks = tasks.map((entry) => (entry.id === saved.id ? saved : entry)); } },
  plans: { list: async (ownerId) => plans.filter((entry) => entry.ownerId === ownerId) },
  treeWorkspaces: {
    describe: async (request) => { described.push(request); return SANDBOX as never; },
    state: async () => 'running',
    save: async (treeId) => {
      saves.push(treeId);
      if (saveFails) throw new Error(saveFails);
      return { saved: true as const, owner: 'koala-user-1', repo: `tree-${treeId}`, commit: 'c0ffee' };
    },
    park: async (treeId) => { parked.push(treeId); return ({ saved: false as const, why: 'no documents in this test' }); },
    release: async () => ({ saved: false as const, why: 'no documents in this test' }),
    bring: async () => ({ brought: false as const, why: 'no documents in this test' }),
  },
  environments: {
    forRun: async (request) => {
      const worktree = request.environment?.scope?.worktree;
      return {
        exec: async ({ command }: { command: string }) => {
          commands.push({ worktree, command });
          if (command.startsWith('git add -A && git commit')) dirty = false;
          if (command.startsWith('git status --porcelain')) return { stdout: dirty ? ' M greet.js' : '', stderr: '', exitCode: 0 };
          if (command.includes('rev-parse')) return { stdout: 'c0ffee', stderr: '', exitCode: 0 };
          if (command.startsWith('test -e')) return { stdout: '', stderr: '', exitCode: 1 };
          if (command.includes('missing.txt')) return { stdout: '', stderr: '', exitCode: 1 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        readFile: async () => '',
        writeFile: async (path: string, content: string) => { written.push({ worktree, path, content }); },
        listDir: async () => [],
        deleteFile: async () => undefined,
      } as never;
    },
  },
  registry: { runnable: async (_ownerId, slug) => (procedures[slug] ? { procedure: procedures[slug]!, agent: { slug } } as never : undefined) },
  now: () => 'now',
});

const request = (settings: Record<string, unknown>, inputs: Record<string, unknown> = {}, runInputs: Record<string, unknown> = {}): NodeRequest => ({
  node: { id: 'op', kind: 'host-op', settings, position: { x: 0, y: 0 } },
  origin: 'op',
  inputs,
  execution: 1,
  run: {
    identity: { runId: 'run-g', depth: 0, agentId: 'grove', loopId: 'grove-run', loopVersion: '1', trigger: 'user' },
    launch: { ownerId: 'user-1' },
    handles: new Set(),
    inputs: runInputs,
    counters: {} as never,
    budget: {},
    cleaningUp: false,
    emit: (event: unknown) => { emitted.push(event); },
  },
} as never);

const run = (name: string, inputs: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, runInputs: Record<string, unknown> = {}) =>
  createGroveOperations(deps())[name]!(request({ operation: name, ...settings }, inputs, runInputs)) as Promise<{ exit: string; outputs?: Record<string, unknown> }>;

const TREE = { id: 't1', name: 'Greeter', type: 'application' };

beforeEach(() => {
  trees = [{ id: 't1', ownerId: 'user-1', name: 'Greeter', type: 'application', projectIds: [], createdAt: 'then', updatedAt: 'then' } as Tree];
  branches = [{ id: 'b1', ownerId: 'user-1', treeId: 't1', title: 'Main', messages: [], createdAt: 'then', updatedAt: 'then' } as Branch];
  leaves = [];
  tasks = [];
  plans = [];
  commands = [];
  written = [];
  described = [];
  parked = [];
  procedures = {};
  dirty = false;
  saves = [];
  saveFails = undefined;
  emitted = [];
});

describe('Open Tree', () => {
  it('opens the tree the run was started for, its workspace built for every agent its procedure can start, and puts stranded leaves back', async () => {
    leaves = [leaf('a', { status: 'running' }), leaf('b')];
    procedures = {
      grove: procedureNaming('grove-run', [place('work', 'fan-out', { agent: 'grove-leaf' }), place('judge', 'fan-out', { agent: 'leaf-judge' })]),
      'grove-leaf': procedureNaming('grove-leaf', [place('exec', 'delegate', { agent: 'executor' })]),
    };

    const outcome = await run('grove.open-tree', {}, {}, { treeId: 't1' });

    expect(outcome).toMatchObject({ exit: 'ready', outputs: { tree: TREE, environment: SANDBOX, reset: ['a'] } });
    expect(described).toEqual([{ treeId: 't1', ownerId: 'user-1', agents: ['executor', 'grove-leaf', 'leaf-judge'] }]);
    expect(leaves.find((entry) => entry.id === 'a')?.status).toBe('pending');
  });

  it('is unavailable for a tree that is not the owner\'s, or none at all', async () => {
    expect((await run('grove.open-tree', { treeId: 'elsewhere' })).exit).toBe('unavailable');
    expect((await run('grove.open-tree')).exit).toBe('unavailable');
  });
});

describe('agentsReachable', () => {
  it('follows delegates and fan-outs through groups, once each, even round a loop', async () => {
    const loops = procedureNaming('a', [place('x', 'delegate', { agent: 'b' })]);
    const back = procedureNaming('b', [place('y', 'delegate', { agent: 'a' })]);
    const grouped: Procedure = { ...procedureNaming('g', [place('n', 'note', {})]), groups: [{ id: 'grp', title: 'g', describe: 'g', inputs: [], outputs: [], exits: [], start: 'z', nodes: [place('z', 'fan-out', { agent: 'c' })], wires: [], flow: [] } as never] };

    expect(await agentsReachable(loops, async (agent) => ({ a: loops, b: back } as Record<string, Procedure>)[agent])).toEqual(['a', 'b']);
    expect(await agentsReachable(grouped, async () => undefined)).toEqual(['c']);
  });
});

describe('Leaves', () => {
  it('says work while anything is ready, judge while claims wait, and quiet otherwise', async () => {
    leaves = [leaf('a')];
    tasks = [task('t', 'a')];
    expect((await run('grove.leaves', { tree: TREE })).exit).toBe('work');

    leaves = [leaf('a', { status: 'claimed', claim: { evidence: 'did it', at: 'then', commit: 'c0ffee' } } as never)];
    expect((await run('grove.leaves', { tree: TREE })).exit).toBe('judge');

    leaves = [leaf('a', { status: 'succeeded' })];
    expect((await run('grove.leaves', { tree: TREE })).exit).toBe('quiet');
  });
});

describe('Prepare Worktrees', () => {
  it('gives each leaf its worktree, says who else is working beside it, and writes a replan\'s failure into its worktree', async () => {
    leaves = [leaf('a'), leaf('b', { status: 'failed' })];

    const outcome = await run('grove.prepare-worktrees', {
      tree: TREE,
      environment: SANDBOX,
      leaves: [{ id: 'a', title: 'leaf a' }, { leafId: 'b', leafTitle: 'leaf b', failure: 'the test never ran' }],
    });

    expect(outcome.exit).toBe('ready');
    const items = (outcome.outputs!.items as Record<string, unknown>[]);
    expect(items.map((item) => [item.leafId, item.worktree])).toEqual([['a', 'trees/a'], ['b', 'trees/b']]);
    expect(items[1]).toMatchObject({ leafFailure: 'leaves/b.failed.md' });
    expect(items[1]).not.toHaveProperty('failure');
    expect(items[0]!.siblings).toMatch(/1 other leaves/);
    expect(written).toEqual([expect.objectContaining({ worktree: 'trees/b', path: 'leaves/b.failed.md', content: expect.stringContaining('the test never ran') })]);
    expect(commands.some((entry) => entry.worktree === 'trees/b' && entry.command.includes('git add leaves/b.failed.md'))).toBe(true);
  });
});

describe('Start Leaf, Return Leaf', () => {
  it('starts a waiting leaf once, and puts back only a running one', async () => {
    leaves = [leaf('a')];
    expect((await run('grove.start-leaf', { leaf: { item: { leafId: 'a' }, index: 0 } })).exit).toBe('started');
    expect(leaves[0]!.runId, 'the leaf does not say which run works it, so it cannot be stopped alone').toBe('run-g');
    expect((await run('grove.start-leaf', { leaf: { leafId: 'a' } })).exit).toBe('notWaiting');
    await run('grove.return-leaf', { leaf: { leafId: 'a' } });
    expect(leaves[0]!.status).toBe('pending');

    leaves = [leaf('a', { status: 'claimed' })];
    await run('grove.return-leaf', { leaf: { leafId: 'a' } });
    expect(leaves[0]!.status).toBe('claimed');
  });
});

describe('Next Task', () => {
  it('hands out the next task with what its siblings are, and stops the work when a task has failed', async () => {
    tasks = [task('t', 'a', { status: 'accepted' })];
    const open = await run('grove.next-task', { leaf: { leafId: 'a', siblings: 'one other leaf' } });
    expect(open).toMatchObject({ exit: 'run', outputs: { task: { id: 't', leafId: 'a', siblings: 'one other leaf' } } });

    tasks = [task('t', 'a', { status: 'failed', runs: ['r1'], evidence: 'still broken' })];
    const stopped = await run('grove.next-task', { leaf: { leafId: 'a' } });
    expect(stopped).toMatchObject({ exit: 'stopped', outputs: { reason: '"task t" failed: still broken' } });
  });

  it('says claim when every task is done, and unbroken when there are none', async () => {
    tasks = [task('t', 'a', { status: 'done' })];
    expect((await run('grove.next-task', { leaf: { leafId: 'a' } })).exit).toBe('claim');
    expect((await run('grove.next-task', { leaf: { leafId: 'z' } })).exit).toBe('unbroken');
  });
});

describe('File Claim', () => {
  it('commits what the work left uncommitted, then files the claim with the run\'s own account', async () => {
    leaves = [leaf('a', { status: 'running' })];
    dirty = true;

    const outcome = await run('grove.file-claim', { leaf: { leafId: 'a' }, environment: SANDBOX, evidence: 'wrote paper.md' }, { result: 'claimed' });

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ exit: 'filed' });
    expect(commands.filter((entry) => entry.worktree === 'trees/a').map((entry) => entry.command)).toEqual(expect.arrayContaining([expect.stringMatching(/^git add -A && git commit/)]));
    expect(leaves[0]).toMatchObject({ status: 'claimed', claim: { evidence: expect.stringContaining('wrote paper.md') } });
  });

  it('saves the tree\'s repository once the claim is filed, so the leaf\'s documents open from Gitea', async () => {
    leaves = [leaf('a', { status: 'running' })];

    await run('grove.file-claim', { leaf: { leafId: 'a' }, environment: SANDBOX, evidence: 'wrote paper.md' }, { result: 'claimed' });

    expect(saves).toEqual(['t1']);
    expect(emitted).toEqual([]);
  });

  it('still files the claim when the save fails, and says so', async () => {
    leaves = [leaf('a', { status: 'running' })];
    saveFails = 'Gitea is down';

    const outcome = await run('grove.file-claim', { leaf: { leafId: 'a' }, environment: SANDBOX, evidence: 'wrote paper.md' }, { result: 'claimed' });

    expect(outcome.exit).toBe('filed');
    expect(leaves[0]).toMatchObject({ status: 'claimed' });
    expect(emitted).toEqual([{ type: 'notice', level: 'info', message: 'the tree\'s repository was not saved after this leaf: Gitea is down' }]);
  });

  it('cuts a writer\'s long account down to what a claim can carry', async () => {
    leaves = [leaf('a', { status: 'running' })];

    await run('grove.file-claim', { leaf: { leafId: 'a' }, environment: SANDBOX, evidence: 'x'.repeat(5000) }, { result: 'claimed' });

    expect((leaves[0]!.claim?.evidence ?? '').length).toBeLessThan(2100);
  });

  it('files a failure with its reason, and commits nothing', async () => {
    leaves = [leaf('a', { status: 'running' })];
    dirty = true;

    const outcome = await run('grove.file-claim', { leaf: { leafId: 'a' }, environment: SANDBOX, reason: '"task t" failed 2 times' }, { result: 'failed' });

    expect(outcome.exit).toBe('filed');
    expect(leaves[0]).toMatchObject({ status: 'failed' });
    expect(commands.some((entry) => entry.command.startsWith('git add -A'))).toBe(false);
  });
});

describe('Check Claims', () => {
  it('settles a claim whose own checks fail, without a judge, and passes the rest on', async () => {
    leaves = [
      leaf('a', { status: 'claimed', claim: { evidence: 'x', at: 'then', commit: 'c0ffee' } } as never),
      leaf('b', { status: 'claimed', claim: { evidence: 'y', at: 'then', commit: 'c0ffee' } } as never),
    ];
    tasks = [task('ta', 'a', { status: 'done', checks: { fileExists: 'missing.txt' } }), task('tb', 'b', { status: 'done' })];

    const outcome = await run('grove.check-claims', { tree: TREE, environment: SANDBOX, claimed: [{ id: 'a' }, { id: 'b' }] });

    expect(outcome).toMatchObject({ exit: 'judge', outputs: { toJudge: [{ id: 'b' }], settled: [{ leafId: 'a', report: expect.stringContaining('missing.txt') }] } });
    expect(leaves.find((entry) => entry.id === 'a')).toMatchObject({ status: 'failed', review: { model: 'grove-check-runner' } });
  });

  it('hands a claim whose work stopped on a failed task to its judge with the failing checks, rather than settling it', async () => {
    leaves = [leaf('a', { status: 'claimed', claim: { evidence: 'x', at: 'then', commit: 'c0ffee' } } as never)];
    tasks = [task('ta', 'a', { status: 'failed', checks: { fileExists: 'missing.txt' } })];

    const outcome = await run('grove.check-claims', { tree: TREE, environment: SANDBOX, claimed: [{ id: 'a' }] });

    expect(outcome).toMatchObject({ exit: 'judge', outputs: { toJudge: [{ id: 'a', checks: expect.stringContaining('missing.txt') }], settled: [] } });
    expect(leaves.find((entry) => entry.id === 'a')).toMatchObject({ status: 'claimed' });
  });
});

describe('Judge Checkouts', () => {
  it('gives each claim a checkout of the commit it points at, with what its judge needs', async () => {
    leaves = [leaf('a', { status: 'claimed', claim: { evidence: 'x', at: 'then', commit: 'c0ffee' } } as never)];

    const outcome = await run('grove.judge-checkouts', { tree: TREE, environment: SANDBOX, claims: [{ id: 'a' }] });

    expect(outcome).toMatchObject({ exit: 'ready', outputs: { items: [{ leafId: 'a', leafBody: 'a works', treeId: 't1', worktree: expect.stringMatching(/a$/), claim: { evidence: 'x' } }] } });
  });

  it('carries the checks a stopped claim failed on to its judge', async () => {
    leaves = [leaf('a', { status: 'claimed', claim: { evidence: 'x', at: 'then', commit: 'c0ffee' } } as never)];

    const outcome = await run('grove.judge-checkouts', { tree: TREE, environment: SANDBOX, claims: [{ id: 'a', checks: 'missing.txt is not there' }] });

    expect(outcome).toMatchObject({ outputs: { items: [{ leafId: 'a', checks: 'missing.txt is not there' }] } });
  });
});

describe('Needs Plan', () => {
  it('hands a planner each leaf to replan or break down, opening on what to do, and honours its replan setting', async () => {
    leaves = [leaf('a', { status: 'failed', findings: 'the build broke', replans: 2 } as never), leaf('b')];

    const open = await run('grove.needs-plan', { tree: TREE });
    expect(open).toMatchObject({ exit: 'some', outputs: { items: [
      { leafId: 'a', mode: 'replan', goal: 'Replan the leaf "leaf a".', message: 'Replan the leaf "leaf a".', leafBrief: 'leaves/a.md', failure: expect.stringContaining('the build broke') },
      { leafId: 'b', mode: 'breakdown', goal: 'Break down the leaf "leaf b".' },
    ] } });

    const capped = await run('grove.needs-plan', { tree: TREE }, { replans: 2 });
    expect((capped.outputs!.items as { leafId: string }[]).map((item) => item.leafId)).toEqual(['b']);
  });

  it('leaves alone a leaf with a plan already waiting', async () => {
    leaves = [leaf('b')];
    plans = [{ id: 'p1', ownerId: 'user-1', status: 'proposed', leafPlan: { leafId: 'b' } } as never];
    expect((await run('grove.needs-plan', { tree: TREE })).exit).toBe('none');
    expect(await run('grove.open-proposals', { tree: TREE })).toMatchObject({ exit: 'some', outputs: { proposals: ['p1'] } });
  });
});

describe('Park Tree, Grove Report', () => {
  it('parks the workspace, and reports in the shape the tree page reads', async () => {
    await run('grove.park-tree', { tree: TREE });
    expect(parked).toEqual(['t1']);

    const report = await run('grove.report', { tree: TREE, awaitingReview: [{ id: 'a' }], proposals: ['p1'] }, { outcome: 'quiet' });
    expect(report).toEqual({ exit: 'done', outputs: { result: { treeId: 't1', outcome: 'quiet', awaitingReview: ['a'], awaitingApproval: ['p1'] } } });
  });
});
