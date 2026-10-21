import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { ApplicationFailure } from '@temporalio/common';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AdoptPlanWorkflow } from './AdoptPlanWorkflow.js';
import { createAgentRegistry } from '../engine-host/registries/registry.js';
import { createEnvironmentResolver } from '../engine-host/sandboxes/environments.js';
import { createRunEnvironments, environmentIdFor } from '../engine-host/sandboxes/run-environments.js';
import { createTreeWorkspaces } from '../engine-host/sandboxes/tree-workspaces.js';
import { createSandboxDriver } from '../engine-host/drivers/sandbox.js';
import { createPlanAdoption } from '../engine-host/plan-adoption.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import { createEngineActivities } from '../engine-host/temporal/activities.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import type { WorkspaceDocuments } from '../engine-host/sandboxes/workspace-documents.js';
import type { PlanProposal } from '../lib/plan-proposals.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { Task } from '../engine-host/tools/tasks.js';
import type { AdoptPlanResult } from '../engine-host/temporal/contracts.js';
import { seededProcedures } from '../extensions/seeds.js';
import { timeSkippingTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await timeSkippingTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const proposal = (over: Partial<PlanProposal> = {}): PlanProposal => ({
  id: 'p1',
  ownerId: 'user-1',
  conversationId: 'conv-1',
  status: 'adopting',
  plan: {
    tree: { name: 'Widget API', type: 'api-service', goal: 'A small API' },
    planDoc: '# Widget API\n\nAssumption: Node 22.',
    branches: [{
      title: 'Operability',
      leaves: [
        {
          key: 'health', title: 'Health endpoint', body: 'GET /health answers 200 with the sha', brief: 'Keep it dependency-free.', dependsOn: [],
          tasks: [
            { key: 'a', title: 'Handler', description: 'Write it', role: 'The probe target', doneMeans: 'curl answers 200', dependsOn: [], checks: { fileExists: 'src/health.ts' } },
            { key: 'b', title: 'Test', description: 'Cover it', role: 'Keeps it honest', doneMeans: 'the test passes', dependsOn: ['a'] },
          ],
        },
        { key: 'deploy', title: 'Deploy', body: 'It runs in the cluster', brief: 'Use the chart.', dependsOn: ['health'], tasks: [] },
      ],
    }],
  },
  createdAt: 'then',
  updatedAt: 'then',
  ...over,
});

function world(start: PlanProposal[], options: { saved?: string[]; homes?: boolean; bound?: string[] } = {}) {
  const stopped: string[] = [];
  const proposals = [...start];
  const trees: Tree[] = [];
  const branches = new Map<string, Branch>();
  const leaves = new Map<string, Leaf>();
  const tasks = new Map<string, Task>();
  const files = new Map<string, string>();
  const commands: string[] = [];
  let repoExists = false;
  const repoFiles: string[] = [];
  const provisioned: string[] = [];
  const kubeCalls: string[][] = [];
  const bound: string[] = [];
  const chosen: unknown[] = [];
  const alreadyBound = new Set<string>(options.bound ?? []);

  const registry = createAgentRegistry();
  const resolver = createEnvironmentResolver({
    registry,
    environments: createRunEnvironments({
      provision: async ({ id, spec }) => {
        provisioned.push(id);
        return createSandboxDriver({
          sandboxId: id,
          spec,
          backend: {
            exec: async ({ command }) => {
              commands.push(command);
              // `test -d <repo>/.git` is how the adoption asks whether it is the one creating the repo.
              if (command.includes('test -d') && command.includes('/.git')) {
                return { stdout: '', stderr: '', exitCode: repoExists ? 0 : 1 };
              }
              if (command.includes('git init')) repoExists = true;
              if (command.includes('grep -l -F')) {
                const ids = [...command.matchAll(/-e '`([^`]+)`'/g)].map((match) => match[1]!);
                const found = [...files.entries()].filter(([path, content]) => path.startsWith('repo/leaves/') && ids.some((id) => content.includes(`\`${id}\``))).map(([path]) => path.slice('repo/'.length));
                return { stdout: found.map((path) => `${path}\n`).join(''), stderr: '', exitCode: 0 };
              }
              if (command.includes('for f in') && command.includes('test -e')) return { stdout: repoFiles.map((file) => `${file}\n`).join(''), stderr: '', exitCode: 0 };
              return { stdout: command.includes('rev-parse HEAD') ? 'c0ffee\n' : '', stderr: '', exitCode: 0 };
            },
            readFile: async ({ path }) => files.get(path) ?? '',
            writeFile: async ({ path, content }) => { files.set(path, content); },
            listDir: async () => [],
            deleteFile: async () => undefined,
          },
        });
      },
    }),
    images: {
      ensure: async (plan) => plan.base,
      exists: async () => true,
      start: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
      standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }),
    },
    tools: async () => [],
  });
  const brought: { from: string; into: string; workspace: string; planWritten: boolean }[] = [];
  const documents: WorkspaceDocuments = {
    save: async () => ({ saved: false, why: 'not saved in this test' }),
    restore: async () => ({ restored: false, why: 'not restored in this test' }),
    catchUp: async () => undefined,
    sendBranch: async () => ({ commit: '' }),
    keepBranch: async () => ({ kept: false as const, why: 'not here' }),
    takeBranch: async () => ({ brought: false as const, why: 'not here' }),
    applyDrop: async () => ({ brought: false as const, why: 'not here' }),
    holds: async () => false,
    dropBranch: async () => undefined,
    merge: async () => 'merged',
    bring: async (request) => {
      brought.push({ from: request.from, into: request.path, workspace: request.workspaceRunId, planWritten: files.has('repo/PLAN.md') });
      return options.saved ? { brought: options.saved } : { brought: false, why: `nothing has been saved to ${request.from}` };
    },
  };
  const kube: KubeRunner = async (args) => {
    kubeCalls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  // The type the proposal's tree is of, with the scaffold it ships.
  const treeTypes = [{
    id: 'api-service',
    label: 'API / service',
    summary: 'Something that runs and answers requests.',
    language: 'node',
    produces: 'service',
    doneMeans: 'It answers.',
    files: [
      { path: 'README.md', content: '# {{projectName}}\n\nPush to {{registryHost}}.' },
      { path: 'scripts/build.sh', content: '#!/bin/sh\necho {{projectName}}', executable: true },
    ],
  }] as TreeTypeSpec[];

  const needsAsked: { ownerId: string; treeId: string; taskIds: string[] }[] = [];
  const planAdoption = createPlanAdoption({
    stores: {
      proposals: {
        get: async (ownerId, id) => proposals.find((entry) => entry.id === id && entry.ownerId === ownerId),
        save: async (entry) => {
          const index = proposals.findIndex((candidate) => candidate.id === entry.id);
          proposals[index] = entry;
        },
      },
      trees: {
        list: async () => trees,
        save: async (tree) => {
          const index = trees.findIndex((candidate) => candidate.id === tree.id);
          if (index >= 0) trees[index] = tree;
          else trees.push(tree);
        },
      },
      branches: { list: async () => [...branches.values()], save: async (branch) => { branches.set(branch.id, branch); } },
      leaves: { list: async () => [...leaves.values()], save: async (leaf) => { leaves.set(leaf.id, leaf); } },
      tasks: { list: async (ownerId) => [...tasks.values()].filter((task) => task.ownerId === ownerId), save: async (task) => { tasks.set(task.id, task); } },
      conversations: {
        bind: async (ownerId, conversationId, binding) => {
          if (alreadyBound.has(conversationId)) return false;
          alreadyBound.add(conversationId);
          bound.push(`${ownerId} ${conversationId} -> ${binding.treeId}${binding.projectId ? ` / ${binding.projectId}` : ''}`);
          return true;
        },
      },
    },
    treeWorkspaces: createTreeWorkspaces({ resolver, kube, documents }),
    environments: resolver,
    treeTypes: async () => treeTypes,
    registryHost: 'registry.test',
    ...(options.homes ? {
      homeTree: async (tree: Tree) => {
        if (tree.projectIds?.length) return tree;
        const homed = { ...tree, projectIds: [`project-${tree.id}`] };
        trees[trees.findIndex((candidate) => candidate.id === tree.id)] = homed;
        return homed;
      },
    } : {}),
    stopRun: async (workflowId: string) => { stopped.push(workflowId); },
    projectChoices: async (ownerId: string, projectId: string, choices: unknown) => { chosen.push({ ownerId, projectId, choices }); },
    checkNeeds: async (ownerId: string, treeId: string, taskIds: readonly string[]) => { needsAsked.push({ ownerId, treeId, taskIds: [...taskIds] }); return { added: [], waiting: [] }; },
    now: () => 'now',
  });

  const activities = createEngineActivities({ planAdoption } as never);

  const told: string[] = [];
  return { needsAsked, told, chosen, stopped, proposals, trees, branches, leaves, tasks, files, commands, provisioned, kubeCalls, activities, brought, bound, markRepoExists: (...present: string[]) => { repoExists = true; repoFiles.push(...present); } };
}

async function adopt(w: ReturnType<typeof world>, proposalId = 'p1', growing?: () => never): Promise<AdoptPlanResult> {
  const taskQueue = `adopt-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname),
    activities: {
      PlanAdoptStopActivity: w.activities.PlanAdoptStopActivity,
      PlanAdoptRecordsActivity: w.activities.PlanAdoptRecordsActivity,
      PlanAdoptDocumentsActivity: w.activities.PlanAdoptDocumentsActivity,
      PlanAdoptSettleActivity: w.activities.PlanAdoptSettleActivity,
      GroveRunInputActivity: async ({ treeId, ownerId }: { treeId: string; ownerId: string }) => (growing ? growing() : {
        ticket: { runId: `grove-run-${treeId}`, depth: 0, ownerId, agentSlug: 'grove', trigger: 'user' as const },
        procedure: seededProcedures().find((procedure) => procedure.id === 'grove-run')!,
        inputs: { treeId, message: 'Grow the tree.' },
      }),
    },
  });
  const streamWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: DEFAULT_STREAM_TASK_QUEUE,
    activities: { EngineGroveChangedActivity: async ({ ownerId }: { ownerId: string }) => { w.told.push(ownerId); } },
  });
  return streamWorker.runUntil(worker.runUntil(() => env.client.workflow.execute(AdoptPlanWorkflow, {
    args: [{ ownerId: 'user-1', proposalId }],
    taskQueue,
    workflowId: `adopt-${Math.random().toString(36).slice(2, 8)}`,
  })));
}

describe('AdoptPlanWorkflow', () => {
  it('builds the approved plan into the grove, writes the plan into the tree\'s sandbox and parks it', async () => {
    const w = world([proposal()]);

    const result = await adopt(w);

    expect(result).toMatchObject({ status: 'adopted', treeId: 'plan-p1-tree', commit: 'c0ffee' });
    expect(result.growing).toEqual({ started: true });
    expect(w.told, 'the owner\'s browsers are told the grove changed').toEqual(['user-1']);
    expect((await env.client.workflow.getHandle('grove-run-plan-p1-tree').describe()).type).toBe('AgentRunWorkflow');
    await env.client.workflow.getHandle('grove-run-plan-p1-tree').terminate('test over').catch(() => undefined);
    expect(w.trees).toEqual([expect.objectContaining({ id: 'plan-p1-tree', ownerId: 'user-1', name: 'Widget API', type: 'api-service', projectIds: [] })]);
    expect([...w.branches.values()]).toEqual([expect.objectContaining({ id: 'plan-p1-b0', treeId: 'plan-p1-tree', title: 'Operability' })]);

    const health = w.leaves.get('plan-p1-b0-l0')!;
    expect(health).toMatchObject({ status: 'pending', branchId: 'plan-p1-b0', tasks: ['plan-p1-b0-l0-t0', 'plan-p1-b0-l0-t1'] });
    expect(w.leaves.get('plan-p1-b0-l1')).toMatchObject({ status: 'pending', dependsOn: ['plan-p1-b0-l0'], tasks: [] });
    expect(w.tasks.get('plan-p1-b0-l0-t1')).toMatchObject({ status: 'accepted', leafId: 'plan-p1-b0-l0', dependsOn: ['plan-p1-b0-l0-t0'], role: 'Keeps it honest' });
    expect(w.tasks.get('plan-p1-b0-l0-t0')?.checks, 'the planner\'s checks were dropped at adoption').toEqual({ fileExists: 'src/health.ts' });
    expect(w.tasks.get('plan-p1-b0-l0-t1')?.checks).toBeUndefined();

    expect([...w.files.keys()]).toEqual([
      'repo/README.md', 'repo/scripts/build.sh',
      'repo/PLAN.md', 'repo/leaves/plan-p1-b0-l0.md', 'repo/leaves/plan-p1-b0-l1.md',
    ]);
    // The scaffold is rendered for this project, and a script ships runnable.
    expect(w.files.get('repo/README.md')).toBe('# Widget API\n\nPush to registry.test.');
    expect(w.files.get('repo/scripts/build.sh')).toContain('echo Widget API');
    expect(w.commands.some((command) => command.startsWith('chmod +x') && command.includes('repo/scripts/build.sh'))).toBe(true);
    expect(w.files.get('repo/PLAN.md')).toContain('## The grove: Widget API (`plan-p1-tree`)');
    expect(w.commands.some((command) => command.includes('git init'))).toBe(true);
    expect(w.commands.some((command) => command.includes("commit -q -m 'plan: p1'"))).toBe(true);
    expect(w.provisioned).toEqual([environmentIdFor('tree-plan-p1-tree')]);
    expect(w.kubeCalls.map((args) => args.slice(0, 2).join(' '))).toEqual(['delete pod']);

    expect(w.proposals[0]).toMatchObject({
      status: 'adopted',
      adopted: { treeId: 'plan-p1-tree', branchIds: ['plan-p1-b0'], leafIds: { health: 'plan-p1-b0-l0', deploy: 'plan-p1-b0-l1' }, commit: 'c0ffee' },
    });
    expect(w.needsAsked, 'once the plan is written, its tasks\' checks are given what they need').toEqual([{ ownerId: 'user-1', treeId: 'plan-p1-tree', taskIds: ['plan-p1-b0-l0-t0', 'plan-p1-b0-l0-t1'] }]);
  }, 60_000);

  it("adds only the starter files an existing repository lacks when a plan makes a tree in it, leaving its own alone", async () => {
    const w = world([proposal()]);
    w.markRepoExists('README.md');

    await adopt(w);

    expect(w.files.has('repo/README.md')).toBe(false);
    expect(w.files.get('repo/scripts/build.sh')).toContain('echo Widget API');
    expect(w.files.get('repo/PLAN.md')).toContain('Widget API');
  }, 60_000);

  it('copies what the conversation saved into the new tree before writing the plan, so the plan wins any path both have', async () => {
    const w = world([proposal()], { saved: ['research/r1/findings.md'] });

    await adopt(w);

    expect(w.brought).toEqual([{ from: 'research-conv-1', into: '/work/repo', workspace: 'tree-plan-p1-tree', planWritten: false }]);
    expect(w.files.get('repo/PLAN.md')).toContain('Widget API');
    expect(w.commands.some((command) => command.includes("commit -q -m 'plan: p1'"))).toBe(true);
  }, 60_000);

  it('brings nothing in when the plan was not proposed in a conversation', async () => {
    const w = world([proposal({ conversationId: undefined })]);

    expect(await adopt(w)).toMatchObject({ status: 'adopted' });
    expect(w.brought).toEqual([]);
  }, 60_000);

  it('links a new tree planned in a conversation about a project to that project', async () => {
    const w = world([proposal({ projectId: 'project-9' })]);

    await adopt(w);

    expect(w.trees).toEqual([expect.objectContaining({ id: 'plan-p1-tree', projectIds: ['project-9'] })]);
  }, 60_000);

  it('gives a new tree with no project the home its type calls for, so its tasks belong to that project', async () => {
    const w = world([proposal()], { homes: true });

    await adopt(w);

    expect(w.trees).toEqual([expect.objectContaining({ id: 'plan-p1-tree', projectIds: ['project-plan-p1-tree'] })]);
    expect([...w.tasks.values()].map((task) => task.projectId)).toEqual([...w.tasks.values()].map(() => 'project-plan-p1-tree'));
    expect(w.tasks.size).toBeGreaterThan(0);
  }, 60_000);

  it('gives the new tree\'s project how it is released and that it waits for the client\'s database, when the plan says so', async () => {
    const plain = world([proposal()], { homes: true });
    await adopt(plain);
    expect(plain.chosen).toEqual([]);
    const base = proposal();
    const w = world([{ ...base, plan: { ...base.plan!, tree: { ...base.plan!.tree!, release: { agent: 'release-careful', app: 'odoo' }, startsFrom: 'client-database' } } } as never], { homes: true });
    await adopt(w);
    expect(w.chosen).toEqual([{ ownerId: 'user-1', projectId: 'project-plan-p1-tree', choices: { release: { agent: 'release-careful', app: 'odoo' }, startsFrom: 'client-database' } }]);
  }, 60_000);

  it('keeps the project a new tree was planned into', async () => {
    const w = world([proposal({ projectId: 'project-9' })], { homes: true });

    await adopt(w);

    expect(w.trees).toEqual([expect.objectContaining({ id: 'plan-p1-tree', projectIds: ['project-9'] })]);
  }, 60_000);

  it('gives the new tree its service name, and joins the project of the service it claims', async () => {
    const base = proposal();
    const w = world([proposal({ plan: { ...base.plan!, tree: { ...base.plan!.tree!, serviceName: 'widgets', joins: { treeId: 't0', treeName: 'Old widgets', projectId: 'project-7' } } } })]);

    await adopt(w);

    expect(w.trees).toEqual([expect.objectContaining({ id: 'plan-p1-tree', serviceName: 'widgets', projectIds: ['project-7'] })]);
  }, 60_000);

  it('adopting the same plan again rewrites the same records instead of doubling them', async () => {
    const w = world([proposal()]);

    await adopt(w);
    await adopt(w);

    expect(w.trees).toHaveLength(1);
    expect(w.branches.size).toBe(1);
    expect(w.leaves.size).toBe(2);
    expect(w.tasks.size).toBe(2);
  }, 60_000);

  it('binds the conversation a new tree was planned in to that tree and its project, so asking there later is about it', async () => {
    const w = world([proposal({ id: 'p5' } as never)], { homes: true });
    await adopt(w, 'p5');
    expect(w.bound).toEqual(['user-1 conv-1 -> plan-p5-tree / project-plan-p5-tree']);
    await env.client.workflow.getHandle('grove-run-plan-p5-tree').terminate('test over').catch(() => undefined);
  }, 60_000);

  it('leaves a conversation already about a tree as it is', async () => {
    const w = world([proposal({ id: 'p6' } as never)], { bound: ['conv-1'] });
    await adopt(w, 'p6');
    expect(w.bound).toEqual([]);
    await env.client.workflow.getHandle('grove-run-plan-p6-tree').terminate('test over').catch(() => undefined);
  }, 60_000);

  it('keeps a plan adopted when its tree cannot be started, and says why', async () => {
    const w = world([proposal({ id: 'p9' } as never)]);
    const result = await adopt(w, 'p9', () => { throw ApplicationFailure.nonRetryable('there is no agent called "grove" to grow this tree'); });
    expect(result).toMatchObject({ status: 'adopted', growing: { started: false, reason: 'there is no agent called "grove" to grow this tree' } });
    expect(w.proposals.find((entry) => entry.id === 'p9')).toMatchObject({ status: 'adopted' });
  }, 60_000);

  it('marks the proposal failed with the reason when the tree it grows is gone, and builds nothing', async () => {
    const w = world([proposal({ plan: { ...proposal().plan!, tree: undefined, treeId: 'gone' } })]);

    const result = await adopt(w);

    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('tree gone, which no longer exists') });
    expect(w.proposals[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('no longer exists') });
    expect(w.leaves.size).toBe(0);
    expect(w.files.size).toBe(0);
  }, 120_000);

  it('adopts a leaf plan: drops the leaf\'s unfinished tasks, adds the new ones, resets the leaf, rewrites its brief, and runs the tree again', async () => {
    const leafProposal: PlanProposal = {
      id: 'p2', ownerId: 'user-1', status: 'adopting', createdAt: 'then', updatedAt: 'then',
      leafPlan: {
        treeId: 'tree-r', leafId: 'leaf-r', leafTitle: 'Serve it', mode: 'replan',
        why: 'nginx is not installed; python3 is', brief: 'Serve with python3 -m http.server.',
        tasks: [{ key: 'serve', title: 'Serve with python', description: 'python3 -m http.server 8080 in site/', role: 'The page answers', doneMeans: 'curl :8080 answers 200', dependsOn: [], checks: { command: 'curl -s -o /dev/null -w %{http_code} :8080', expects: ['200'] } }],
      },
    };
    const w = world([leafProposal]);
    w.trees.push({ id: 'tree-r', ownerId: 'user-1', name: 'Site', type: 'freeform', projectIds: [], createdAt: 'then', updatedAt: 'then' } as never);
    w.branches.set('branch-r', { id: 'branch-r', ownerId: 'user-1', treeId: 'tree-r', title: 'Serve', messages: [], createdAt: 'then', updatedAt: 'then' } as never);
    w.leaves.set('leaf-r', { id: 'leaf-r', ownerId: 'user-1', branchId: 'branch-r', title: 'Serve it', body: 'curl :8080 answers', status: 'failed', findings: 'nginx is not installed', claim: { evidence: 'tried', at: 'then' }, createdAt: 'then', updatedAt: 'then' } as never);
    w.tasks.set('old-done', { id: 'old-done', ownerId: 'user-1', leafId: 'leaf-r', title: 'Write the page', doneMeans: 'x', dependsOn: [], status: 'done', runs: [], createdAt: 'then', updatedAt: 'then' } as never);
    w.tasks.set('old-failed', { id: 'old-failed', ownerId: 'user-1', leafId: 'leaf-r', title: 'Start nginx', doneMeans: 'x', dependsOn: [], status: 'failed', runs: [], createdAt: 'then', updatedAt: 'then' } as never);

    const result = await adopt(w, 'p2');

    expect(result).toMatchObject({ status: 'adopted', treeId: 'tree-r' });
    expect(w.tasks.get('old-failed')?.status).toBe('dropped');
    expect(w.tasks.get('old-done')?.status).toBe('done');
    expect(w.tasks.get('plan-p2-t0')).toMatchObject({ status: 'accepted', leafId: 'leaf-r', title: 'Serve with python' });
    expect(w.tasks.get('plan-p2-t0')?.checks, 'the replan\'s checks were dropped at adoption').toEqual({ command: 'curl -s -o /dev/null -w %{http_code} :8080', expects: ['200'] });
    expect(w.leaves.get('leaf-r')).toMatchObject({ status: 'pending', replans: 1, tasks: ['old-done', 'plan-p2-t0'], attempts: [{ attempt: 1, error: 'nginx is not installed' }] });
    expect(w.leaves.get('leaf-r')?.claim).toBeUndefined();
    expect(w.files.get('repo/leaves/leaf-r.md')).toContain('Serve with python3 -m http.server.');
    expect(w.files.get('repo/leaves/leaf-r.md')).toContain('_Replanned: nginx is not installed; python3 is_');
    expect(w.commands.some((command) => command.includes("commit -q -m 'replan: Serve it'"))).toBe(true);

    const run = await env.client.workflow.getHandle('grove-run-tree-r').describe();
    expect(run.type).toBe('AgentRunWorkflow');
    await env.client.workflow.getHandle('grove-run-tree-r').terminate('test over');
  }, 60_000);

  const changeWorld = (change: PlanProposal['change']) => {
    const w = world([{ id: 'p3', ownerId: 'user-1', conversationId: 'story-chat', status: 'adopting', change, createdAt: 'then', updatedAt: 'then' }]);
    w.trees.push({ id: 'tree-c', ownerId: 'user-1', name: 'Shop', type: 'odoo-addons', projectIds: ['project-c'], createdAt: 'then', updatedAt: 'then' } as never);
    w.branches.set('branch-c', { id: 'branch-c', ownerId: 'user-1', treeId: 'tree-c', title: 'The field', createdAt: 'then', updatedAt: 'then' });
    w.leaves.set('leaf-a', { id: 'leaf-a', ownerId: 'user-1', branchId: 'branch-c', title: 'Note on screen', body: 'The form shows the note', status: 'running', runId: 'leaf-run-a', createdAt: 'then', updatedAt: 'then' });
    w.leaves.set('leaf-b', { id: 'leaf-b', ownerId: 'user-1', branchId: 'branch-c', title: 'Note in the list', body: 'The list shows the note', status: 'pending', dependsOn: ['leaf-a'], createdAt: 'then', updatedAt: 'then' });
    w.tasks.set('t-done', { id: 't-done', ownerId: 'user-1', leafId: 'leaf-a', title: 'Add the field', doneMeans: 'it exists', dependsOn: [], status: 'done', runs: [], createdAt: 'then', updatedAt: 'then' });
    w.tasks.set('t-busy', { id: 't-busy', ownerId: 'user-1', leafId: 'leaf-a', title: 'Show it', doneMeans: 'it shows', dependsOn: [], status: 'running', runs: [], createdAt: 'then', updatedAt: 'then' });
    w.files.set('repo/leaves/leaf-a.md', '# Note on screen\n\nLeaf `leaf-a`\n\n## The goal the judge checks\n\nThe form shows the note\n\nWaits on: nothing\n\n## Brief\n\nInherit the sale order form view.\n\n## Tasks\n\nNone\n');
    w.files.set('repo/leaves/leaf-b.md', '# Note in the list\n\nLeaf `leaf-b`\n\nWaits on: `leaf-a`\n\n## Brief\n\nB\n\n## Tasks\n\nNone\n');
    w.files.set('repo/PLAN.md', '# Shop\n');
    return w;
  };

  it('applies a story change: stops the worker on it, starts it again from the change, rewrites its brief and PLAN.md, and runs the tree', async () => {
    const w = changeWorld({
      treeId: 'tree-c', why: 'print it too',
      edit: { leafId: 'leaf-a', body: 'The form and the printed order show the note' },
      before: [], outcome: [],
    });

    const result = await adopt(w, 'p3');

    expect(result).toMatchObject({ status: 'adopted', treeId: 'tree-c', growing: { started: true } });
    expect(w.stopped).toEqual(['leaf-run-a']);
    expect(w.leaves.get('leaf-a')).toMatchObject({ status: 'pending', body: 'The form and the printed order show the note', attempts: [{ attempt: 1, error: 'stopped and started again: print it too', runId: 'leaf-run-a', change: 'p3' }] });
    expect(w.leaves.get('leaf-a')?.runId).toBeUndefined();
    expect(w.tasks.get('t-busy')?.status).toBe('accepted');
    const brief = w.files.get('repo/leaves/leaf-a.md')!;
    expect(brief).toContain('The form and the printed order show the note');
    expect(brief).toContain('Inherit the sale order form view.\n\n_Changed: print it too_');
    expect(brief).toContain('### Add the field (`t-done`)');
    expect(w.files.get('repo/PLAN.md')).toContain('## Changed: Change “Note on screen” (change `p3`)\n\nprint it too\n\n- **Note on screen** (`leaf-a`): its goal changed');
    expect(w.commands.some((command) => command.includes("commit -q -m 'change: p3'"))).toBe(true);
    expect(w.bound).toEqual([]);
    await env.client.workflow.getHandle('grove-run-tree-c').terminate('test over');
  }, 60_000);

  it('adds stories in a feature the change opens, making the feature only once it is approved', async () => {
    const w = changeWorld({
      treeId: 'tree-c', why: 'keep what the client made',
      add: {
        branchId: 'tree-c-customizations', branchTitle: 'Customizations from the live app', newBranch: true,
        leaves: [{ key: 'adopt', title: 'Bring 1 customization made in the app into git', body: 'addons/shop_customizations installs', brief: 'Export it.', dependsOn: [], tasks: [{ key: 'export', title: 'Export it', description: 'Call export_customizations.', role: 'All of it.', doneMeans: 'it installs', dependsOn: [] }] }],
      },
      before: [], outcome: [],
    });
    expect(w.branches.has('tree-c-customizations')).toBe(false);

    const result = await adopt(w, 'p3');

    expect(result).toMatchObject({ status: 'adopted', growing: { started: true } });
    expect(w.branches.get('tree-c-customizations')).toMatchObject({ treeId: 'tree-c', title: 'Customizations from the live app', ownerId: 'user-1' });
    expect([...w.leaves.values()].find((leaf) => leaf.branchId === 'tree-c-customizations')).toMatchObject({ title: 'Bring 1 customization made in the app into git', status: 'pending' });
    await env.client.workflow.getHandle('grove-run-tree-c').terminate('test over');
  }, 60_000);

  it('applies a cancel: stops the worker, frees what waited on it in the records and its brief, and does not run the tree', async () => {
    const w = changeWorld({ treeId: 'tree-c', why: 'not wanted', cancel: ['leaf-a'], before: [], outcome: [] });

    const result = await adopt(w, 'p3');

    expect(result).toMatchObject({ status: 'adopted', growing: { started: false } });
    expect(w.stopped).toEqual(['leaf-run-a']);
    expect(w.leaves.get('leaf-a')).toMatchObject({ status: 'cancelled', findings: 'Cancelled: not wanted' });
    expect(w.leaves.get('leaf-b')?.dependsOn).toBeUndefined();
    expect(w.tasks.get('t-busy')?.status).toBe('dropped');
    expect(w.files.get('repo/leaves/leaf-b.md')).toContain('Waits on: nothing');
    expect(w.files.get('repo/PLAN.md')).toContain('- **Note on screen** (`leaf-a`): cancelled');
  }, 60_000);
});
