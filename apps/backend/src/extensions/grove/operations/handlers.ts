import type { NodeRequest, Procedure, StepResult } from '@koala/agent-engine/procedure';
import type { EnvironmentDriver } from '@koala/engine-core';
import { createGroveTools } from '../tools/grove-tools.js';
import { prepareJudgeCheckout, prepareLeafWorktree, pruneLeafWorktrees, WorktreeConflictError } from '../../../engine-host/grove-worktrees.js';
import { claimEvidenceFor, leavesNeedingPlan, nextLeafStep, runEvidence, taskItem } from '../../../lib/grove-leaf.js';
import { checkReport, checksFailed, runTaskChecks, type CheckOutcome } from '../../../lib/task-checks.js';
import { judgeCheckout, leafBriefPath, leafContext, leafFailurePath, leafWorktree, renderLeafFailure } from '../../../lib/plan-documents.js';
import type { Branch, Leaf } from '../../../lib/leaves.js';
import type { Tree } from '../../../lib/trees.js';
import type { Task } from '../../../engine-host/tools/tasks.js';
import type { PlanProposal } from '../../../lib/plan-proposals.js';
import type { TreeSandbox, TreeWorkspaces } from '../../../engine-host/sandboxes/tree-workspaces.js';
import type { EnvironmentResolver } from '../../../engine-host/sandboxes/environments.js';
import type { AgentRegistry } from '../../../engine-host/registries/registry.js';
import type { HostOperationRun } from '../../types.js';

export interface GroveOperationDeps {
  trees: { list(): Promise<Tree[]> };
  branches: { list(): Promise<Branch[]> };
  leaves: { list(): Promise<Leaf[]>; save(leaf: Leaf): Promise<void> };
  tasks: { list(ownerId: string): Promise<Task[]>; save(task: Task): Promise<void> };
  plans: { list(ownerId: string): Promise<PlanProposal[]> };
  treeWorkspaces: TreeWorkspaces;
  environments: Pick<EnvironmentResolver, 'forRun'>;
  registry: Pick<AgentRegistry, 'runnable'>;
  now?: (() => string) | undefined;
}

interface OpenedTree {
  id: string;
  name: string;
  type?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const listOf = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const leafIdOf = (value: Record<string, unknown>): string | undefined => {
  const id = value.leafId ?? value.id;
  return typeof id === 'string' && id ? id : undefined;
};

function leafFrom(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.item)) return value.item;
  return value;
}

function treeFrom(request: NodeRequest): OpenedTree {
  const tree = request.inputs.tree;
  if (!isRecord(tree) || typeof tree.id !== 'string') throw new Error('this needs the tree, as Open Tree hands it on');
  return { id: tree.id, name: String(tree.name ?? tree.id), ...(typeof tree.type === 'string' ? { type: tree.type } : {}) };
}

function sandboxFrom(request: NodeRequest): TreeSandbox {
  const environment = request.inputs.environment as TreeSandbox | undefined;
  if (environment?.kind !== 'sandbox') throw new Error('this needs the tree\'s shared workspace, as Open Tree hands it on');
  return environment;
}

const ownerOf = (request: NodeRequest): string => request.run.launch.ownerId;

export function agentsReachable(procedure: Procedure, procedureOf: (agent: string) => Promise<Procedure | undefined>): Promise<string[]> {
  const seen = new Set<string>();
  const walk = async (from: Procedure): Promise<void> => {
    const nodes = [...from.nodes, ...(from.groups ?? []).flatMap((group) => group.nodes)];
    for (const node of nodes) {
      if (node.kind !== 'delegate' && node.kind !== 'fan-out') continue;
      const agent = node.settings?.agent;
      if (typeof agent !== 'string' || !agent || seen.has(agent)) continue;
      seen.add(agent);
      const next = await procedureOf(agent);
      if (next) await walk(next);
    }
  };
  return walk(procedure).then(() => [...seen].sort());
}

export function createGroveOperations(deps: GroveOperationDeps): Record<string, HostOperationRun> {
  const now = deps.now ?? (() => new Date().toISOString());

  const treeLeaves = async (treeId: string, ownerId: string): Promise<Leaf[]> => {
    const branchIds = new Set((await deps.branches.list()).filter((branch) => branch.treeId === treeId).map((branch) => branch.id));
    return (await deps.leaves.list()).filter((leaf) => leaf.ownerId === ownerId && branchIds.has(leaf.branchId));
  };

  const driverFor = async (request: NodeRequest, environment: TreeSandbox, treeId: string, worktree?: string): Promise<EnvironmentDriver> => {
    const driver = await deps.environments.forRun({
      ticket: { runId: `grove-${treeId}-ops`, depth: 0, ownerId: ownerOf(request), agentSlug: request.run.identity.agentId, trigger: 'agent' },
      environment: { id: environment.id, spec: environment.capabilities, workspace: environment.workspace, ...(worktree ? { scope: { worktree } } : {}) },
    });
    if (!driver) throw new Error(`the tree's workspace could not be reached${worktree ? ` in ${worktree}` : ''}`);
    return driver;
  };

  const groveTools = (ownerId: string, writable: boolean) => {
    const refuse = async (): Promise<void> => { throw new Error('a grove operation only writes leaves'); };
    return createGroveTools({
      stores: {
        trees: { list: deps.trees.list, save: refuse },
        branches: { list: deps.branches.list, save: refuse },
        leaves: { list: deps.leaves.list, save: writable ? deps.leaves.save : refuse },
        tasks: { list: () => deps.tasks.list(ownerId) },
      },
    });
  };

  const openProposals = async (ownerId: string, leafIds: readonly string[]): Promise<PlanProposal[]> => {
    const inTree = new Set(leafIds);
    return (await deps.plans.list(ownerId)).filter((proposal) =>
      proposal.leafPlan && inTree.has(proposal.leafPlan.leafId) && (proposal.status === 'proposed' || proposal.status === 'adopting'));
  };

  const setStatus = async (request: NodeRequest, leafId: string, from: Leaf['status'][], to: Leaf['status'], also: Partial<Leaf> = {}): Promise<Leaf | undefined> => {
    const leaf = (await deps.leaves.list()).find((entry) => entry.id === leafId && entry.ownerId === ownerOf(request));
    if (!leaf || !from.includes(leaf.status)) return undefined;
    const moved = { ...leaf, ...also, status: to, updatedAt: now() };
    await deps.leaves.save(moved);
    return moved;
  };

  return {
    async 'grove.open-tree'(request): Promise<StepResult> {
      const ownerId = ownerOf(request);
      const asked = typeof request.inputs.treeId === 'string' && request.inputs.treeId ? request.inputs.treeId : request.run.inputs.treeId;
      if (typeof asked !== 'string' || !asked) return { exit: 'unavailable', outputs: { reason: 'no treeId was wired in, and the run was not started with one' } };
      const tree = (await deps.trees.list()).find((entry) => entry.id === asked && entry.ownerId === ownerId);
      if (!tree) return { exit: 'unavailable', outputs: { reason: `there is no tree "${asked}"` } };

      const runnable = await deps.registry.runnable(ownerId, request.run.identity.agentId);
      const agents = runnable
        ? await agentsReachable(runnable.procedure, async (agent) => (await deps.registry.runnable(ownerId, agent))?.procedure)
        : [];
      let environment: TreeSandbox;
      try {
        environment = await deps.treeWorkspaces.describe({ treeId: tree.id, ownerId, agents });
      } catch (err) {
        return { exit: 'unavailable', outputs: { reason: `the tree's workspace could not be had: ${(err as Error).message}` } };
      }

      const stranded = (await treeLeaves(tree.id, ownerId)).filter((leaf) => leaf.status === 'running');
      for (const leaf of stranded) await deps.leaves.save({ ...leaf, status: 'pending', updatedAt: now() });

      return {
        exit: 'ready',
        outputs: {
          tree: { id: tree.id, name: tree.name, ...(tree.type ? { type: tree.type } : {}) },
          environment,
          reset: stranded.map((leaf) => leaf.id),
        },
      };
    },

    async 'grove.leaves'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const outcome = await groveTools(ownerOf(request), false)['ready_leaves']!({
        name: 'ready_leaves',
        parsed: { treeId: tree.id },
        driver: undefined,
        caller: { ownerId: ownerOf(request), runId: request.run.identity.runId, agentSlug: request.run.identity.agentId },
      });
      if (!outcome.ok) throw new Error(`the tree's leaves could not be read: ${outcome.digest}`);
      const read = JSON.parse(outcome.content ?? '{}') as Record<string, unknown>;
      const outputs = {
        ready: listOf(read.ready),
        claimed: listOf(read.claimed),
        awaitingReview: listOf(read.awaitingReview),
        unbroken: listOf(read.unbroken),
        blocked: listOf(read.blocked),
        settled: listOf(read.settled),
      };
      const exit = outputs.ready.length > 0 ? 'work' : outputs.claimed.length > 0 ? 'judge' : 'quiet';
      return { exit, outputs };
    },

    async 'grove.prepare-worktrees'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const environment = sandboxFrom(request);
      const ownerId = ownerOf(request);
      const wanted = listOf(request.inputs.leaves);
      const leaves = await treeLeaves(tree.id, ownerId);
      const driver = await driverFor(request, environment, tree.id);
      await pruneLeafWorktrees(driver, leaves.map((leaf) => leaf.id));

      const items: Record<string, unknown>[] = [];
      const failed: Record<string, unknown>[] = [];
      for (const asked of wanted) {
        const leafId = leafIdOf(asked);
        const leaf = leaves.find((entry) => entry.id === leafId);
        if (!leafId || !leaf) continue;
        const dependencies = (leaf.dependsOn ?? []).map((id) => {
          const commit = leaves.find((entry) => entry.id === id)?.claim?.commit;
          return { leafId: id, ...(commit ? { commit } : {}) };
        });
        try {
          await prepareLeafWorktree(driver, leafId, dependencies);
          const { failure, ...rest } = asked;
          const worktree = leafWorktree(leafId);
          if (typeof failure === 'string' && failure.trim()) {
            const scoped = await driverFor(request, environment, tree.id, worktree);
            const path = leafFailurePath(leafId);
            await scoped.writeFile(path, renderLeafFailure({ leafId, leafTitle: leaf.title, failure }));
            await scoped.exec({
              command: `git add ${path} && git -c user.name=koala -c user.email=koala@grove.local commit -q -m 'why this leaf is being replanned'`,
              timeoutMs: 60_000,
            });
            items.push({ ...rest, leafId, worktree, leafFailure: path });
          } else {
            items.push({ ...rest, leafId, worktree });
          }
        } catch (err) {
          if (!(err instanceof WorktreeConflictError)) throw err;
          const reason = `could not prepare its worktree: ${err.message}`;
          await deps.leaves.save({ ...leaf, status: 'failed', findings: reason, updatedAt: now() });
          failed.push({ leafId, reason });
        }
      }

      if (items.length > 1) {
        for (const item of items) {
          item.siblings = `${items.length - 1} other leaves of this tree are being worked at the same time, each in its own worktree — keep to ${String(item.leafTitle ?? item.title ?? item.leafId)}.`;
        }
      }
      return { exit: items.length > 0 ? 'ready' : 'none', outputs: { items, failed } };
    },

    async 'grove.start-leaf'(request): Promise<StepResult> {
      const asked = leafFrom(request.inputs.leaf);
      const leafId = asked ? leafIdOf(asked) : undefined;
      if (!asked || !leafId) throw new Error('Start Leaf needs a leaf with a leafId');
      const started = await setStatus(request, leafId, ['pending'], 'running', { runId: request.run.identity.runId });
      return started ? { exit: 'started', outputs: { leaf: asked } } : { exit: 'notWaiting', outputs: { leaf: asked } };
    },

    async 'grove.next-task'(request): Promise<StepResult> {
      const asked = leafFrom(request.inputs.leaf);
      const leafId = asked ? leafIdOf(asked) : undefined;
      if (!asked || !leafId) throw new Error('Next Task needs a leaf with a leafId');
      const tasks = (await deps.tasks.list(ownerOf(request))).filter((task) => task.leafId === leafId);
      const attempts = request.node.settings.taskAttempts;
      const step = nextLeafStep(tasks, { taskAttempts: typeof attempts === 'number' ? attempts : undefined });

      if (step.kind === 'claim') return { exit: 'claim', outputs: {} };
      if (step.kind === 'unbroken') return { exit: 'unbroken', outputs: {} };
      if (step.kind === 'fail') return { exit: 'fail', outputs: { reason: step.reason } };
      const task = tasks.find((entry) => entry.id === step.taskIds[0])!;
      const siblings = typeof asked.siblings === 'string' ? asked.siblings : undefined;
      return { exit: 'run', outputs: { task: taskItem(leafId, task, siblings) } };
    },

    async 'grove.file-claim'(request): Promise<StepResult> {
      const asked = leafFrom(request.inputs.leaf);
      const leafId = asked ? leafIdOf(asked) : undefined;
      if (!asked || !leafId) throw new Error('File Claim needs a leaf with a leafId');
      const environment = sandboxFrom(request);
      const ownerId = ownerOf(request);
      const result = request.node.settings.result === 'failed' ? 'failed' : 'claimed';
      const leaf = (await deps.leaves.list()).find((entry) => entry.id === leafId && entry.ownerId === ownerId);
      if (!leaf) return { exit: 'refused', outputs: { reason: `there is no leaf "${leafId}"` } };
      const branch = (await deps.branches.list()).find((entry) => entry.id === leaf.branchId);
      const driver = await driverFor(request, environment, branch?.treeId ?? leafId, leafWorktree(leafId));

      if (result === 'claimed') {
        const left = await driver.exec({ command: 'git status --porcelain', timeoutMs: 60_000 });
        if (left.exitCode === 0 && left.stdout.trim()) {
          const message = `leaf ${leaf.title}: work its tasks left uncommitted`;
          await driver.exec({ command: `git add -A && git commit -q -m '${message.replace(/'/g, `'\\''`)}'`, timeoutMs: 60_000 });
        }
      }

      const tasks = (await deps.tasks.list(ownerId)).filter((task) => task.leafId === leafId);
      const said = typeof request.inputs.evidence === 'string' && request.inputs.evidence.trim() ? runEvidence({ result: request.inputs.evidence }) : undefined;
      const reason = typeof request.inputs.reason === 'string' && request.inputs.reason.trim() ? request.inputs.reason : undefined;
      const outcome = await groveTools(ownerId, true)['claim_leaf']!({
        name: 'claim_leaf',
        parsed: { leafId, result, evidence: claimEvidenceFor(tasks, said), ...(reason ? { reason } : {}) },
        driver,
        caller: { ownerId, runId: request.run.identity.runId, agentSlug: request.run.identity.agentId },
      });
      if (!outcome.ok) return { exit: 'refused', outputs: { reason: outcome.digest } };
      const filed = (await deps.leaves.list()).find((entry) => entry.id === leafId);
      return { exit: 'filed', outputs: { claim: filed?.claim ?? { result } } };
    },

    async 'grove.return-leaf'(request): Promise<StepResult> {
      const asked = leafFrom(request.inputs.leaf);
      const leafId = asked ? leafIdOf(asked) : undefined;
      if (leafId) await setStatus(request, leafId, ['running'], 'pending');
      return { exit: 'done', outputs: {} };
    },

    async 'grove.check-claims'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const environment = sandboxFrom(request);
      const ownerId = ownerOf(request);
      const claimed = listOf(request.inputs.claimed);
      const tasks = await deps.tasks.list(ownerId);
      const toJudge: Record<string, unknown>[] = [];
      const settled: Record<string, unknown>[] = [];

      for (const claim of claimed) {
        const leafId = leafIdOf(claim);
        if (!leafId) continue;
        const withChecks = tasks.filter((task) => task.leafId === leafId && task.checks);
        if (withChecks.length === 0) { toJudge.push(claim); continue; }

        const commit = (await deps.leaves.list()).find((entry) => entry.id === leafId)?.claim?.commit;
        const checkout = commit ? await prepareJudgeCheckout(await driverFor(request, environment, tree.id), leafId, commit) : undefined;
        const driver = await driverFor(request, environment, tree.id, checkout ? judgeCheckout(leafId) : leafWorktree(leafId));
        const sandbox = {
          exec: async (command: string) => driver.exec({ command, timeoutMs: 60_000 }),
          readFile: (path: string) => driver.readFile(path).catch(() => undefined),
        };
        const outcomes: CheckOutcome[] = [];
        for (const task of withChecks) outcomes.push(...await runTaskChecks(sandbox, task.checks));
        if (!checksFailed(outcomes)) { toJudge.push(claim); continue; }

        const report = checkReport(outcomes);
        await groveTools(ownerId, true)['settle_leaf']!({
          name: 'settle_leaf',
          parsed: { leafId, verdict: 'failed', note: `its own checks failed:\n${report}` },
          driver,
          caller: { ownerId, runId: request.run.identity.runId, agentSlug: 'grove-check-runner' },
        });
        settled.push({ leafId, report });
      }

      return { exit: toJudge.length > 0 ? 'judge' : 'settled', outputs: { toJudge, settled } };
    },

    async 'grove.judge-checkouts'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const environment = sandboxFrom(request);
      const driver = await driverFor(request, environment, tree.id);
      const leaves = await treeLeaves(tree.id, ownerOf(request));
      const items: Record<string, unknown>[] = [];
      for (const claim of listOf(request.inputs.claims)) {
        const leafId = leafIdOf(claim);
        const leaf = leaves.find((entry) => entry.id === leafId);
        if (!leafId || !leaf) continue;
        const commit = await prepareJudgeCheckout(driver, leafId, leaf.claim?.commit);
        const worktree = commit ? judgeCheckout(leafId) : leafWorktree(leafId);
        items.push({
          leafId,
          leafTitle: leaf.title,
          leafBody: leaf.body,
          treeId: tree.id,
          branchId: leaf.branchId,
          worktree,
          context: { ...leafContext(leafId), worktree, ...(commit ? { commit } : {}) },
          ...(leaf.claim ? { claim: leaf.claim } : {}),
        });
      }
      return { exit: 'ready', outputs: { items } };
    },

    async 'grove.needs-plan'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const ownerId = ownerOf(request);
      const leaves = await treeLeaves(tree.id, ownerId);
      const open = await openProposals(ownerId, leaves.map((leaf) => leaf.id));
      const replans = request.node.settings.replans;
      const needs = leavesNeedingPlan(
        leaves,
        await deps.tasks.list(ownerId),
        new Set(open.map((proposal) => proposal.leafPlan!.leafId)),
        { attempts: typeof replans === 'number' ? replans : undefined },
      );
      const items = needs.map((need) => {
        const goal = `${need.mode === 'replan' ? 'Replan' : 'Break down'} the leaf "${need.leafTitle}".`;
        return {
          treeId: tree.id,
          leafId: need.leafId,
          leafTitle: need.leafTitle,
          leafBody: need.leafBody,
          leafBrief: leafBriefPath(need.leafId),
          mode: need.mode,
          goal,
          message: goal,
          ...(need.failure ? { failure: need.failure } : {}),
        };
      });
      return { exit: items.length > 0 ? 'some' : 'none', outputs: { items } };
    },

    async 'grove.open-proposals'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const ownerId = ownerOf(request);
      const leaves = await treeLeaves(tree.id, ownerId);
      const proposals = (await openProposals(ownerId, leaves.map((leaf) => leaf.id))).map((proposal) => proposal.id);
      return { exit: proposals.length > 0 ? 'some' : 'none', outputs: { proposals } };
    },

    async 'grove.park-tree'(request): Promise<StepResult> {
      const tree = request.inputs.tree;
      if (isRecord(tree) && typeof tree.id === 'string') await deps.treeWorkspaces.park(tree.id);
      return { exit: 'done', outputs: {} };
    },

    async 'grove.report'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const outcome = request.node.settings.outcome === 'stopped' ? 'stopped' : 'quiet';
      const awaitingReview = listOf(request.inputs.awaitingReview).map((leaf) => leafIdOf(leaf)).filter((id): id is string => Boolean(id));
      const awaitingApproval = Array.isArray(request.inputs.proposals) ? request.inputs.proposals.filter((id): id is string => typeof id === 'string') : [];
      return { exit: 'done', outputs: { result: { treeId: tree.id, outcome, awaitingReview, awaitingApproval } } };
    },
  };
}
