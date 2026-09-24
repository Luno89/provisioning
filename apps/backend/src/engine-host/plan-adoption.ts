import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import { primaryProjectId } from '../lib/trees.js';
import { newTask, type Task } from '../lib/tasks.js';
import type { AdoptedPlan, PlanProposal, PlanStatus } from '../lib/plan-proposals.js';
import { planDocuments, TREE_REPO } from '../lib/plan-documents.js';
import type { EnvironmentResolver } from './sandboxes/environments.js';
import type { TreeWorkspaces } from './sandboxes/tree-workspaces.js';

export interface PlanAdoptionStores {
  proposals: {
    get(ownerId: string, id: string): Promise<PlanProposal | undefined>;
    save(proposal: PlanProposal): Promise<void>;
  };
  trees: { list(): Promise<Tree[]>; save(tree: Tree): Promise<void> };
  branches: { save(branch: Branch): Promise<void> };
  leaves: { save(leaf: Leaf): Promise<void> };
  tasks: { save(task: Task): Promise<void> };
}

export interface PlanAdoptionOptions {
  stores: PlanAdoptionStores;
  treeWorkspaces: TreeWorkspaces;
  environments: Pick<EnvironmentResolver, 'forRun'>;
  now?: (() => string) | undefined;
}

export interface AdoptedRecords {
  adopted: AdoptedPlan;
  treeName: string;
}

export interface PlanAdoption {
  records(ownerId: string, proposalId: string): Promise<AdoptedRecords>;
  documents(ownerId: string, proposalId: string, records: AdoptedRecords): Promise<string>;
  settle(ownerId: string, proposalId: string, outcome: { status: Extract<PlanStatus, 'adopted' | 'failed'>; adopted?: AdoptedPlan | undefined; reason?: string | undefined }): Promise<void>;
}

const shell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function createPlanAdoption(options: PlanAdoptionOptions): PlanAdoption {
  const now = options.now ?? (() => new Date().toISOString());

  const proposalOf = async (ownerId: string, id: string): Promise<PlanProposal> => {
    const proposal = await options.stores.proposals.get(ownerId, id);
    if (!proposal) throw new Error(`no plan proposal ${id} for this owner`);
    return proposal;
  };

  return {
    async records(ownerId, proposalId) {
      const proposal = await proposalOf(ownerId, proposalId);
      const { plan } = proposal;
      const stamp = now();
      const idOf = (suffix: string) => `plan-${proposalId}-${suffix}`;

      let tree: Tree;
      if (plan.treeId) {
        const found = (await options.stores.trees.list()).find((candidate) => candidate.id === plan.treeId && candidate.ownerId === ownerId);
        if (!found) throw new Error(`the plan grows tree ${plan.treeId}, which no longer exists`);
        tree = found;
      } else if (plan.tree) {
        tree = {
          id: idOf('tree'),
          ownerId,
          name: plan.tree.name,
          type: plan.tree.type,
          ...(plan.tree.goal ? { goal: plan.tree.goal } : {}),
          projectIds: [],
          createdAt: stamp,
          updatedAt: stamp,
        };
        await options.stores.trees.save(tree);
      } else {
        throw new Error('the plan names no tree');
      }
      const projectId = primaryProjectId(tree);

      const leafIds: Record<string, string> = {};
      const taskIds: Record<string, string> = {};
      plan.branches.forEach((branch, b) => branch.leaves.forEach((leaf, l) => {
        leafIds[leaf.key] = idOf(`b${b}-l${l}`);
        leaf.tasks.forEach((task, t) => { taskIds[`${leaf.key}/${task.key}`] = idOf(`b${b}-l${l}-t${t}`); });
      }));

      const branchIds: string[] = [];
      for (const [b, planBranch] of plan.branches.entries()) {
        const branch: Branch = {
          id: idOf(`b${b}`),
          ownerId,
          treeId: tree.id,
          ...(projectId ? { projectId } : {}),
          title: planBranch.title,
          messages: [],
          createdAt: stamp,
          updatedAt: stamp,
        };
        await options.stores.branches.save(branch);
        branchIds.push(branch.id);

        for (const planLeaf of planBranch.leaves) {
          const leafId = leafIds[planLeaf.key]!;
          const dependsOn = planLeaf.dependsOn.map((dependency) => leafIds[dependency] ?? dependency);
          const tasks = planLeaf.tasks.map((planTask) => ({
            ...newTask({
              id: taskIds[`${planLeaf.key}/${planTask.key}`]!,
              ownerId,
              ...(projectId ? { projectId } : {}),
              leafId,
              title: planTask.title,
              description: planTask.description,
              role: planTask.role,
              doneMeans: planTask.doneMeans,
              dependsOn: planTask.dependsOn.map((dependency) => taskIds[`${planLeaf.key}/${dependency}`]!),
            }, stamp),
            status: 'accepted' as const,
          }));
          for (const task of tasks) await options.stores.tasks.save(task);

          const leaf: Leaf = {
            id: leafId,
            ownerId,
            branchId: branch.id,
            title: planLeaf.title,
            body: planLeaf.body,
            column: 'todo',
            status: 'pending',
            runner: 'engine',
            depth: 0,
            blocking: false,
            tasks: tasks.map((task) => task.id),
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            createdAt: stamp,
            updatedAt: stamp,
          };
          await options.stores.leaves.save(leaf);
        }
      }

      return { adopted: { treeId: tree.id, branchIds, leafIds, taskIds }, treeName: tree.name };
    },

    async documents(ownerId, proposalId, { adopted, treeName }) {
      const proposal = await proposalOf(ownerId, proposalId);
      const shared = await options.treeWorkspaces.describe({ treeId: adopted.treeId, ownerId });
      const driver = await options.environments.forRun({
        ticket: { runId: `plan-${proposalId}`, depth: 0, ownerId, agentSlug: 'planner', trigger: 'user' },
        environment: { id: shared.id, spec: shared.capabilities, workspace: shared.workspace },
      });
      if (!driver) throw new Error('the tree sandbox could not be reached to write the plan');

      const run = async (command: string): Promise<string> => {
        const outcome = await driver.exec({ command, timeoutMs: 60_000 });
        if (outcome.exitCode !== 0) throw new Error(`${command.split(' ')[0]} failed: ${(outcome.stderr || outcome.stdout).trim()}`);
        return outcome.stdout.trim();
      };

      await run(`mkdir -p ${TREE_REPO} && cd ${TREE_REPO} && (git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)`);
      const documents = planDocuments(proposal.plan, adopted, treeName);
      for (const document of documents) await driver.writeFile(`${TREE_REPO}/${document.path}`, document.content);
      const paths = documents.map((document) => shell(document.path)).join(' ');
      await run(`cd ${TREE_REPO} && git add ${paths} && (git diff --cached --quiet || git -c user.name=koala -c user.email=koala@grove.local commit -q -m ${shell(`plan: ${proposalId}`)})`);
      const commit = await run(`cd ${TREE_REPO} && git rev-parse HEAD`);

      await options.treeWorkspaces.park(adopted.treeId);
      return commit;
    },

    async settle(ownerId, proposalId, outcome) {
      const proposal = await proposalOf(ownerId, proposalId);
      await options.stores.proposals.save({
        ...proposal,
        status: outcome.status,
        ...(outcome.adopted ? { adopted: outcome.adopted } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        updatedAt: now(),
      });
    },
  };
}
