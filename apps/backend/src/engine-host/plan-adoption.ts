import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import { primaryProjectId } from '../lib/trees.js';
import { newTask, type Task } from './tools/tasks.js';
import type { AdoptedPlan, PlanProposal, PlanStatus } from '../lib/plan-proposals.js';
import { leafBriefPath, leafWorktree, PLAN_DOC_PATH, planDocuments, renderLeafBrief, TREE_REPO } from '../lib/plan-documents.js';
import { renderStarterFiles, resolveTreeType, type TreeTypeSpec } from '../lib/tree-types.js';
import { resetForRetry } from '../lib/leaves.js';
import type { EnvironmentResolver } from './sandboxes/environments.js';
import type { TreeWorkspaces } from './sandboxes/tree-workspaces.js';

export interface PlanAdoptionStores {
  proposals: {
    get(ownerId: string, id: string): Promise<PlanProposal | undefined>;
    save(proposal: PlanProposal): Promise<void>;
  };
  trees: { list(): Promise<Tree[]>; save(tree: Tree): Promise<void> };
  branches: { list(): Promise<Branch[]>; save(branch: Branch): Promise<void> };
  leaves: { list(): Promise<Leaf[]>; save(leaf: Leaf): Promise<void> };
  tasks: { list(ownerId: string): Promise<Task[]>; save(task: Task): Promise<void> };
}

export interface PlanAdoptionOptions {
  stores: PlanAdoptionStores;
  treeWorkspaces: TreeWorkspaces;
  environments: Pick<EnvironmentResolver, 'forRun'>;
  /** The types this owner can see, so a tree they create starts from its type's scaffold. */
  treeTypes?: ((ownerId: string) => Promise<TreeTypeSpec[]>) | undefined;
  /** Where the project's registry is reached, which a scaffold file may name. */
  registryHost?: string | undefined;
  now?: (() => string) | undefined;
}

export interface AdoptedRecords {
  adopted: AdoptedPlan;
  treeName: string;
  kind: 'tree' | 'leaf';
}

export interface PlanAdoption {
  records(ownerId: string, proposalId: string): Promise<AdoptedRecords>;
  documents(ownerId: string, proposalId: string, records: AdoptedRecords): Promise<string>;
  settle(ownerId: string, proposalId: string, outcome: { status: Extract<PlanStatus, 'adopted' | 'failed'>; adopted?: AdoptedPlan | undefined; reason?: string | undefined }): Promise<void>;
}

const shell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function createPlanAdoption(options: PlanAdoptionOptions): PlanAdoption {
  const now = options.now ?? (() => new Date().toISOString());

  /**
   * The files a type ships, rendered for this project: what a new tree starts from, so whoever works
   * a leaf fills in a structure instead of inventing one and a judge has something to check against.
   */
  const scaffoldFor = async (ownerId: string, treeId: string, projectName: string): Promise<{ path: string; content: string; executable?: boolean | undefined }[]> => {
    const treeTypes = options.treeTypes;
    if (!treeTypes) return [];

    const tree = (await options.stores.trees.list()).find((entry) => entry.id === treeId);
    const type = await resolveTreeType(
      { getTreeTypes: async (who?: string) => treeTypes(who ?? ownerId) },
      ownerId,
      tree?.type,
    );
    if (!type?.files?.length) return [];

    return renderStarterFiles(type.files, { projectName, registryHost: options.registryHost ?? '' });
  };

  const proposalOf = async (ownerId: string, id: string): Promise<PlanProposal> => {
    const proposal = await options.stores.proposals.get(ownerId, id);
    if (!proposal) throw new Error(`no plan proposal ${id} for this owner`);
    return proposal;
  };

  return {
    async records(ownerId, proposalId) {
      const proposal = await proposalOf(ownerId, proposalId);
      const stamp = now();
      const idOf = (suffix: string) => `plan-${proposalId}-${suffix}`;

      if (proposal.leafPlan) {
        const leafPlan = proposal.leafPlan;
        const leaf = (await options.stores.leaves.list()).find((entry) => entry.id === leafPlan.leafId && entry.ownerId === ownerId);
        if (!leaf) throw new Error(`the plan is for leaf ${leafPlan.leafId}, which no longer exists`);
        const tree = (await options.stores.trees.list()).find((entry) => entry.id === leafPlan.treeId && entry.ownerId === ownerId);
        if (!tree) throw new Error(`the plan's tree ${leafPlan.treeId} no longer exists`);
        const projectId = primaryProjectId(tree);

        const existing = (await options.stores.tasks.list(ownerId)).filter((task) => task.leafId === leaf.id);
        for (const task of existing.filter((entry) => entry.status !== 'done' && entry.status !== 'dropped')) {
          await options.stores.tasks.save({ ...task, status: 'dropped', updatedAt: stamp });
        }
        const taskIds: Record<string, string> = {};
        leafPlan.tasks.forEach((task, t) => { taskIds[`${leaf.id}/${task.key}`] = idOf(`t${t}`); });
        const added = leafPlan.tasks.map((planTask) => ({
          ...newTask({
            id: taskIds[`${leaf.id}/${planTask.key}`]!,
            ownerId,
            ...(projectId ? { projectId } : {}),
            leafId: leaf.id,
            title: planTask.title,
            description: planTask.description,
            role: planTask.role,
            doneMeans: planTask.doneMeans,
            ...(planTask.checks ? { checks: planTask.checks } : {}),
            dependsOn: planTask.dependsOn.map((dependency) => taskIds[`${leaf.id}/${dependency}`]!),
          }, stamp),
          status: 'accepted' as const,
        }));
        for (const task of added) await options.stores.tasks.save(task);

        const base = leaf.status === 'failed' ? resetForRetry(leaf, [], stamp).leaf : { ...leaf, updatedAt: stamp };
        const kept = existing.filter((task) => task.status === 'done').map((task) => task.id);
        await options.stores.leaves.save({
          ...base,
          status: 'pending',
          ...(leafPlan.body ? { body: leafPlan.body } : {}),
          tasks: [...kept, ...added.map((task) => task.id)],
          replans: (leaf.replans ?? 0) + (leafPlan.mode === 'replan' ? 1 : 0),
        });

        return { adopted: { treeId: tree.id, branchIds: [], leafIds: { [leaf.id]: leaf.id }, taskIds }, treeName: tree.name, kind: 'leaf' };
      }

      const plan = proposal.plan;
      if (!plan) throw new Error('the proposal holds no plan');

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
          ...(plan.tree.serviceName ? { serviceName: plan.tree.serviceName } : {}),
          projectIds: proposal.projectId ? [proposal.projectId] : plan.tree.joins?.projectId ? [plan.tree.joins.projectId] : [],
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
          title: planBranch.title,
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
              ...(planTask.checks ? { checks: planTask.checks } : {}),
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
            status: 'pending',
            tasks: tasks.map((task) => task.id),
            ...(dependsOn.length > 0 ? { dependsOn } : {}),
            createdAt: stamp,
            updatedAt: stamp,
          };
          await options.stores.leaves.save(leaf);
        }
      }

      return { adopted: { treeId: tree.id, branchIds, leafIds, taskIds }, treeName: tree.name, kind: 'tree' };
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

      // A repository this adoption is creating starts from its type's scaffold. One that already
      // exists has its own files by now — a tree made in the UI and planned afterwards, or a second
      // plan adopted into a tree whose leaves have worked — and writing over them would undo work.
      const fresh = (await driver.exec({ command: `test -d ${TREE_REPO}/.git`, timeoutMs: 30_000 })).exitCode !== 0;

      await run(`mkdir -p ${TREE_REPO} && cd ${TREE_REPO} && (git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)`);

      if (proposal.leafPlan) {
        const leafPlan = proposal.leafPlan;
        const leaf = (await options.stores.leaves.list()).find((entry) => entry.id === leafPlan.leafId);
        const branchTitle = (await options.stores.branches.list()).find((entry) => entry.id === leaf?.branchId)?.title ?? '';
        const brief = renderLeafBrief({
          key: leafPlan.leafId,
          title: leafPlan.leafTitle,
          body: leafPlan.body ?? leaf?.body ?? '',
          brief: `${leafPlan.brief}\n\n_${leafPlan.mode === 'replan' ? 'Replanned' : 'Broken down'}: ${leafPlan.why}_`,
          dependsOn: leaf?.dependsOn ?? [],
          tasks: leafPlan.tasks,
        }, adopted, branchTitle);
        const path = leafBriefPath(leafPlan.leafId);
        await driver.writeFile(`${TREE_REPO}/${path}`, brief);
        await run(`cd ${TREE_REPO} && git add ${shell(path)} && (git diff --cached --quiet || git -c user.name=koala -c user.email=koala@grove.local commit -q -m ${shell(`${leafPlan.mode}: ${leafPlan.leafTitle}`)})`);
        const commit = await run(`cd ${TREE_REPO} && git rev-parse HEAD`);
        const worktree = `/work/${leafWorktree(leafPlan.leafId)}`;
        await run(`test ! -e ${shell(worktree)}/.git || git -C ${shell(worktree)} merge -q --no-edit main || git -C ${shell(worktree)} merge --abort || true`);
        await options.treeWorkspaces.park(adopted.treeId, ownerId);
        return commit;
      }

      if (!proposal.plan) throw new Error('the proposal holds no plan');
      const earlier = proposal.plan.treeId
        ? (await driver.exec({ command: `cat ${TREE_REPO}/${PLAN_DOC_PATH} 2>/dev/null || true`, timeoutMs: 30_000 })).stdout
        : '';
      if (proposal.conversationId) await options.treeWorkspaces.bring(adopted.treeId, ownerId, proposal.conversationId);
      const documents = planDocuments(proposal.plan, adopted, treeName, { earlier, proposalId });
      const scaffold = fresh ? await scaffoldFor(ownerId, adopted.treeId, treeName) : [];
      const written = [...scaffold, ...documents];
      for (const document of written) await driver.writeFile(`${TREE_REPO}/${document.path}`, document.content);
      const executable = scaffold.filter((file) => file.executable).map((file) => shell(`${TREE_REPO}/${file.path}`));
      if (executable.length > 0) await run(`chmod +x ${executable.join(' ')}`);
      const paths = written.map((document) => shell(document.path)).join(' ');
      await run(`cd ${TREE_REPO} && git add ${paths} && (git diff --cached --quiet || git -c user.name=koala -c user.email=koala@grove.local commit -q -m ${shell(`plan: ${proposalId}`)})`);
      const commit = await run(`cd ${TREE_REPO} && git rev-parse HEAD`);

      await options.treeWorkspaces.park(adopted.treeId, ownerId);
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
