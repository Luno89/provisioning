import type { Branch, Leaf } from '../lib/leaves.js';
import type { Tree } from '../lib/trees.js';
import type { NewTreeSpec } from '@koala/harness-types';
import { primaryProjectId } from '../lib/trees.js';
import { newTask, type Task } from './tools/tasks.js';
import type { AdoptedPlan, PlanProposal, PlanStatus } from '../lib/plan-proposals.js';
import { leafBriefPath, leafWorktree, PLAN_DOC_PATH, planDocuments, renderLeafBrief, TREE_REPO } from '../lib/plan-documents.js';
import { renderStarterFiles, resolveTreeType, versionForNewTree, versionVars, type TreeTypeSpec } from '../lib/tree-types.js';
import { resetForRetry } from '../lib/leaves.js';
import { applyChange, briefIn, renderChangeNote, runsToStop, withWaitsOn, type ChangeWorld } from '../lib/item-changes.js';
import type { EnvironmentResolver } from './sandboxes/environments.js';
import type { TreeWorkspaces } from './sandboxes/tree-workspaces.js';
import type { CheckNeeds } from './check-needs.js';

export interface PlanAdoptionStores {
  proposals: {
    get(ownerId: string, id: string): Promise<PlanProposal | undefined>;
    save(proposal: PlanProposal): Promise<void>;
  };
  trees: { list(): Promise<Tree[]>; save(tree: Tree): Promise<void> };
  branches: { list(): Promise<Branch[]>; save(branch: Branch): Promise<void> };
  leaves: { list(): Promise<Leaf[]>; save(leaf: Leaf): Promise<void> };
  tasks: { list(ownerId: string): Promise<Task[]>; save(task: Task): Promise<void> };
  conversations?: { bind(ownerId: string, conversationId: string, binding: { treeId: string; projectId?: string | undefined }): Promise<boolean> } | undefined;
}

export interface PlanAdoptionOptions {
  stores: PlanAdoptionStores;
  treeWorkspaces: TreeWorkspaces;
  environments: Pick<EnvironmentResolver, 'forRun'>;
  /** The types this owner can see, so a tree they create starts from its type's scaffold. */
  treeTypes?: ((ownerId: string) => Promise<TreeTypeSpec[]>) | undefined;
  /** Where the project's registry is reached, which a scaffold file may name. */
  registryHost?: string | undefined;
  homeTree?: ((tree: Tree) => Promise<Tree>) | undefined;
  projectChoices?: ((ownerId: string, projectId: string, choices: Pick<NewTreeSpec, 'release' | 'startsFrom'>) => Promise<void>) | undefined;
  stopRun?: ((workflowId: string) => Promise<void>) | undefined;
  checkNeeds?: CheckNeeds | undefined;
  now?: (() => string) | undefined;
}

export interface AdoptedRecords {
  adopted: AdoptedPlan;
  treeName: string;
  kind: 'tree' | 'leaf' | 'change';
  grow?: boolean | undefined;
}

export interface PlanAdoption {
  stop(ownerId: string, proposalId: string): Promise<string[]>;
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

    return renderStarterFiles(type.files, { projectName, registryHost: options.registryHost ?? '', ...versionVars(type, tree) });
  };

  const versionOfNewTree = async (ownerId: string, spec: { type: string; version?: string | undefined }): Promise<string | undefined> => {
    const treeTypes = options.treeTypes;
    if (!treeTypes) return spec.version;
    const type = await resolveTreeType({ getTreeTypes: async (who?: string) => treeTypes(who ?? ownerId) }, ownerId, spec.type);
    if (!type) return spec.version;
    const chosen = versionForNewTree(type, spec.version);
    if (!chosen.ok) throw new Error(chosen.error);
    return chosen.version;
  };

  const proposalOf = async (ownerId: string, id: string): Promise<PlanProposal> => {
    const proposal = await options.stores.proposals.get(ownerId, id);
    if (!proposal) throw new Error(`no plan proposal ${id} for this owner`);
    return proposal;
  };

  const changeWorld = async (ownerId: string, treeId: string): Promise<ChangeWorld> => {
    const branchIds = new Set((await options.stores.branches.list()).filter((branch) => branch.treeId === treeId && branch.ownerId === ownerId).map((branch) => branch.id));
    const leaves = (await options.stores.leaves.list()).filter((leaf) => branchIds.has(leaf.branchId) && leaf.ownerId === ownerId);
    const leafIds = new Set(leaves.map((leaf) => leaf.id));
    const tasks = (await options.stores.tasks.list(ownerId)).filter((task) => task.leafId !== undefined && leafIds.has(task.leafId));
    return { treeId, leaves, tasks };
  };

  return {
    async stop(ownerId, proposalId) {
      const proposal = await proposalOf(ownerId, proposalId);
      if (!proposal.change) return [];
      const runs = runsToStop(proposal.change, (await changeWorld(ownerId, proposal.change.treeId)).leaves);
      if (runs.length > 0 && !options.stopRun) throw new Error('a story\'s worker has to be stopped first, and nothing here can stop it');
      for (const run of runs) await options.stopRun!(run);
      return runs;
    },

    async records(ownerId, proposalId) {
      const proposal = await proposalOf(ownerId, proposalId);
      const stamp = now();
      const idOf = (suffix: string) => `plan-${proposalId}-${suffix}`;

      if (proposal.change) {
        const change = proposal.change;
        const tree = (await options.stores.trees.list()).find((entry) => entry.id === change.treeId && entry.ownerId === ownerId);
        if (!tree) throw new Error(`the change's tree ${change.treeId} no longer exists`);
        const projectId = primaryProjectId(tree);
        if (change.add?.newBranch && !(await options.stores.branches.list()).some((entry) => entry.id === change.add!.branchId)) {
          await options.stores.branches.save({ id: change.add.branchId, ownerId, treeId: tree.id, title: change.add.branchTitle, createdAt: stamp, updatedAt: stamp });
        }
        const applied = applyChange(change, await changeWorld(ownerId, tree.id), { proposalId, at: stamp, ...(projectId ? { projectId } : {}) });
        for (const task of applied.tasks) await options.stores.tasks.save(task);
        for (const leaf of applied.leaves) await options.stores.leaves.save(leaf);
        return {
          adopted: { treeId: tree.id, branchIds: change.add ? [change.add.branchId] : [], leafIds: applied.leafIds, taskIds: applied.taskIds },
          treeName: tree.name,
          kind: 'change',
          grow: applied.grow,
        };
      }

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
        const version = await versionOfNewTree(ownerId, plan.tree);
        tree = {
          id: idOf('tree'),
          ownerId,
          name: plan.tree.name,
          type: plan.tree.type,
          ...(version ? { version } : {}),
          ...(plan.tree.goal ? { goal: plan.tree.goal } : {}),
          ...(plan.tree.serviceName ? { serviceName: plan.tree.serviceName } : {}),
          projectIds: proposal.projectId ? [proposal.projectId] : plan.tree.joins?.projectId ? [plan.tree.joins.projectId] : [],
          createdAt: stamp,
          updatedAt: stamp,
        };
        await options.stores.trees.save(tree);
        if (options.homeTree) tree = await options.homeTree(tree);
      } else {
        throw new Error('the plan names no tree');
      }
      const projectId = primaryProjectId(tree);
      if (projectId && plan.tree && (plan.tree.release || plan.tree.startsFrom) && options.projectChoices) {
        await options.projectChoices(ownerId, projectId, { ...(plan.tree.release ? { release: plan.tree.release } : {}), ...(plan.tree.startsFrom ? { startsFrom: plan.tree.startsFrom } : {}) });
      }

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
        const outcome = await driver.exec({ command });
        if (outcome.exitCode !== 0) throw new Error(`${command.split(' ')[0]} failed: ${(outcome.stderr || outcome.stdout).trim()}`);
        return outcome.stdout.trim();
      };

      const fresh = (await driver.exec({ command: `test -d ${TREE_REPO}/.git` })).exitCode !== 0;

      await run(`mkdir -p ${TREE_REPO} && cd ${TREE_REPO} && (git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main)`);

      if (proposal.change) {
        const change = proposal.change;
        const world = await changeWorld(ownerId, change.treeId);
        const branches = await options.stores.branches.list();
        const titleOf = (leafId: string) => world.leaves.find((leaf) => leaf.id === leafId)?.title ?? leafId;
        const read = async (path: string): Promise<string> => (await driver.readFile(`${TREE_REPO}/${path}`).catch(() => '')) ?? '';
        const written: { path: string; content: string }[] = [];
        const touched: string[] = [];

        if (change.edit) {
          const leaf = world.leaves.find((entry) => entry.id === change.edit!.leafId);
          if (!leaf) throw new Error(`story ${change.edit.leafId} no longer exists`);
          const earlier = await read(leafBriefPath(leaf.id));
          const tasks = world.tasks.filter((task) => task.leafId === leaf.id && task.status !== 'dropped').map((task) => ({
            key: task.id,
            title: task.title,
            description: task.description ?? '',
            role: task.role ?? '',
            doneMeans: task.doneMeans,
            dependsOn: task.dependsOn,
            ...(task.checks ? { checks: task.checks } : {}),
          }));
          const brief = change.edit.brief ?? briefIn(earlier) ?? leaf.body ?? '';
          written.push({
            path: leafBriefPath(leaf.id),
            content: renderLeafBrief({ key: leaf.id, title: leaf.title, body: leaf.body ?? '', brief: `${brief}\n\n_Changed: ${change.why}_`, dependsOn: leaf.dependsOn ?? [], tasks }, adopted, branches.find((entry) => entry.id === leaf.branchId)?.title ?? ''),
          });
          touched.push(leaf.id);
        }

        if (change.add) {
          for (const leaf of change.add.leaves) written.push({ path: leafBriefPath(adopted.leafIds[leaf.key] ?? leaf.key), content: renderLeafBrief(leaf, adopted, change.add.branchTitle) });
        }

        if (change.cancel) {
          const gone = new Set(change.cancel);
          const mentioning = (await driver.exec({ command: `cd ${TREE_REPO} && grep -l -F ${[...gone].map((id) => `-e ${shell(`\`${id}\``)}`).join(' ')} leaves/*.md 2>/dev/null || true` })).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
          for (const leaf of world.leaves.filter((entry) => !gone.has(entry.id) && entry.status !== 'cancelled' && mentioning.includes(leafBriefPath(entry.id)))) {
            const document = await read(leafBriefPath(leaf.id));
            const updated = withWaitsOn(document, leaf.dependsOn ?? []);
            if (updated !== document) written.push({ path: leafBriefPath(leaf.id), content: updated });
          }
        }

        written.push({ path: PLAN_DOC_PATH, content: renderChangeNote(await read(PLAN_DOC_PATH), change, adopted, proposalId, titleOf) });
        for (const document of written) await driver.writeFile(`${TREE_REPO}/${document.path}`, document.content);
        await run(`cd ${TREE_REPO} && mkdir -p leaves && git add ${written.map((document) => shell(document.path)).join(' ')} && (git diff --cached --quiet || git -c user.name=koala -c user.email=koala@grove.local commit -q -m ${shell(`change: ${proposalId}`)})`);
        const commit = await run(`cd ${TREE_REPO} && git rev-parse HEAD`);
        for (const leafId of touched) {
          const worktree = `/work/${leafWorktree(leafId)}`;
          await run(`test ! -e ${shell(worktree)}/.git || git -C ${shell(worktree)} merge -q --no-edit main || git -C ${shell(worktree)} merge --abort || true`);
        }
        await options.treeWorkspaces.park(adopted.treeId, ownerId);
        return commit;
      }

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
        ? (await driver.exec({ command: `cat ${TREE_REPO}/${PLAN_DOC_PATH} 2>/dev/null || true` })).stdout
        : '';
      if (proposal.conversationId) await options.treeWorkspaces.bring(adopted.treeId, ownerId, proposal.conversationId);
      const documents = planDocuments(proposal.plan, adopted, treeName, { earlier, proposalId });
      const starter = fresh || !proposal.plan.treeId ? await scaffoldFor(ownerId, adopted.treeId, treeName) : [];
      const present = starter.length > 0
        ? new Set((await driver.exec({ command: `cd ${TREE_REPO} && for f in ${starter.map((file) => shell(file.path)).join(' ')}; do test -e "$f" && echo "$f"; done; true` })).stdout.split('\n').map((line) => line.trim()).filter(Boolean))
        : new Set<string>();
      const scaffold = starter.filter((file) => !present.has(file.path));
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
      if (outcome.status === 'adopted' && outcome.adopted && options.checkNeeds) {
        const needs = await options.checkNeeds(ownerId, outcome.adopted.treeId, Object.values(outcome.adopted.taskIds));
        if (needs.refused) console.warn(`[plan] ${proposalId}: the workspace could not be given what its checks need: ${needs.refused}`);
      }
      if (outcome.status !== 'adopted' || !outcome.adopted || proposal.leafPlan || proposal.change || !proposal.conversationId || !options.stores.conversations) return;
      const tree = (await options.stores.trees.list()).find((entry) => entry.id === outcome.adopted!.treeId && entry.ownerId === ownerId);
      if (!tree) return;
      const projectId = primaryProjectId(tree);
      await options.stores.conversations.bind(ownerId, proposal.conversationId, { treeId: tree.id, ...(projectId ? { projectId } : {}) });
    },
  };
}
