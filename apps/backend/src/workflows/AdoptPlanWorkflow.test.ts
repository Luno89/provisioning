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
import { createEngineActivities } from '../engine-host/temporal/activities.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import type { PlanProposal } from '../lib/plan-proposals.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { Task } from '../lib/tasks.js';
import type { AdoptPlanResult } from '../engine-host/temporal/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
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
            { key: 'a', title: 'Handler', description: 'Write it', role: 'The probe target', doneMeans: 'curl answers 200', dependsOn: [] },
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

function world(start: PlanProposal[]) {
  const proposals = [...start];
  const trees: Tree[] = [];
  const branches = new Map<string, Branch>();
  const leaves = new Map<string, Leaf>();
  const tasks = new Map<string, Task>();
  const files = new Map<string, string>();
  const commands: string[] = [];
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
  const kube: KubeRunner = async (args) => {
    kubeCalls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };

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
      branches: { save: async (branch) => { branches.set(branch.id, branch); } },
      leaves: { save: async (leaf) => { leaves.set(leaf.id, leaf); } },
      tasks: { save: async (task) => { tasks.set(task.id, task); } },
    },
    treeWorkspaces: createTreeWorkspaces({ resolver, kube }),
    environments: resolver,
    now: () => 'now',
  });

  const activities = createEngineActivities({ planAdoption } as never);

  return { proposals, trees, branches, leaves, tasks, files, commands, provisioned, kubeCalls, activities };
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
    expect(w.trees).toEqual([expect.objectContaining({ id: 'plan-p1-tree', ownerId: 'user-1', name: 'Widget API', type: 'api-service' })]);
    expect([...w.branches.values()]).toEqual([expect.objectContaining({ id: 'plan-p1-b0', treeId: 'plan-p1-tree', title: 'Operability' })]);

    const health = w.leaves.get('plan-p1-b0-l0')!;
    expect(health).toMatchObject({ status: 'pending', runner: 'engine', branchId: 'plan-p1-b0', tasks: ['plan-p1-b0-l0-t0', 'plan-p1-b0-l0-t1'] });
    expect(w.leaves.get('plan-p1-b0-l1')).toMatchObject({ status: 'pending', dependsOn: ['plan-p1-b0-l0'], tasks: [] });
    expect(w.tasks.get('plan-p1-b0-l0-t1')).toMatchObject({ status: 'accepted', leafId: 'plan-p1-b0-l0', dependsOn: ['plan-p1-b0-l0-t0'], role: 'Keeps it honest' });

    expect([...w.files.keys()]).toEqual(['repo/PLAN.md', 'repo/leaves/plan-p1-b0-l0.md', 'repo/leaves/plan-p1-b0-l1.md']);
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
    const w = world([proposal({ plan: { ...proposal().plan, tree: undefined, treeId: 'gone' } })]);

    const result = await adopt(w);

    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('tree gone, which no longer exists') });
    expect(w.proposals[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('no longer exists') });
    expect(w.leaves.size).toBe(0);
    expect(w.files.size).toBe(0);
  }, 120_000);
});
