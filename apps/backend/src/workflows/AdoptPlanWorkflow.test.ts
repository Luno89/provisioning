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

function world(start: PlanProposal[], options: { saved?: string[] } = {}) {
  const proposals = [...start];
  const trees: Tree[] = [];
  const branches = new Map<string, Branch>();
  const leaves = new Map<string, Leaf>();
  const tasks = new Map<string, Task>();
  const files = new Map<string, string>();
  const commands: string[] = [];
  let repoExists = false;
  const provisioned: string[] = [];
  const kubeCalls: string[][] = [];

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
    },
    treeWorkspaces: createTreeWorkspaces({ resolver, kube, documents }),
    environments: resolver,
    treeTypes: async () => treeTypes,
    registryHost: 'registry.test',
    now: () => 'now',
  });

  const activities = createEngineActivities({ planAdoption } as never);

  return { proposals, trees, branches, leaves, tasks, files, commands, provisioned, kubeCalls, activities, brought, markRepoExists: () => { repoExists = true; } };
}

async function adopt(w: ReturnType<typeof world>, proposalId = 'p1'): Promise<AdoptPlanResult> {
  const taskQueue = `adopt-test-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname),
    activities: {
      PlanAdoptRecordsActivity: w.activities.PlanAdoptRecordsActivity,
      PlanAdoptDocumentsActivity: w.activities.PlanAdoptDocumentsActivity,
      PlanAdoptSettleActivity: w.activities.PlanAdoptSettleActivity,
      GroveRunInputActivity: async ({ treeId, ownerId }: { treeId: string; ownerId: string }) => ({
        ticket: { runId: `grove-run-${treeId}`, depth: 0, ownerId, agentSlug: 'grove', trigger: 'user' as const },
        procedure: seededProcedures().find((procedure) => procedure.id === 'grove-run')!,
        inputs: { treeId, message: 'Grow the tree.' },
      }),
    },
  });
  return worker.runUntil(() => env.client.workflow.execute(AdoptPlanWorkflow, {
    args: [{ ownerId: 'user-1', proposalId }],
    taskQueue,
    workflowId: `adopt-${Math.random().toString(36).slice(2, 8)}`,
  }));
}

describe('AdoptPlanWorkflow', () => {
  it('builds the approved plan into the grove, writes the plan into the tree\'s sandbox and parks it', async () => {
    const w = world([proposal()]);

    const result = await adopt(w);

    expect(result).toMatchObject({ status: 'adopted', treeId: 'plan-p1-tree', commit: 'c0ffee' });
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
  }, 60_000);

  it("leaves an existing repository's own files alone when a plan grows the tree", async () => {
    const w = world([proposal()]);
    // The repository is already there: a tree made in the UI and planned afterwards, or a second plan
    // adopted into a tree whose leaves have worked.
    w.markRepoExists();

    await adopt(w);

    expect(w.files.has('repo/README.md')).toBe(false);
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
});

