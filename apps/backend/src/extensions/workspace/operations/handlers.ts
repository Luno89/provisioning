import type { ImagePlan, PlanLine } from '@koala/agent-engine';
import type { NodeRequest, StepResult } from '@koala/agent-engine/procedure';
import type { Tree } from '../../../lib/trees.js';
import type { Branch, Leaf } from '../../../lib/leaves.js';
import type { Task } from '../../../engine-host/tools/tasks.js';
import { readWorkspaceFile, type WorkspaceFile } from '../../../lib/workspace-file.js';
import { describeLine, stageText, type NextStage, type NextWorkspace, type PublishedWorkspace } from '../../../lib/published-workspace.js';
import { workspaceNotice, type WorkspaceNoticeKind } from '../../../lib/notices.js';
import type { ComposedWorkspace } from '../../../lib/workspace-composition.js';
import type { HostOperationRun } from '../../types.js';

export interface WorkspaceOperationDeps {
  trees: { list(): Promise<Tree[]> };
  readFile(ownerId: string, treeId: string): Promise<string | undefined>;
  agentsFor(ownerId: string, treeId: string): Promise<string[]>;
  compose(request: { treeId: string; ownerId: string; agents: readonly string[]; file?: WorkspaceFile | undefined }): Promise<ComposedWorkspace>;
  images: { ensure(plan: ImagePlan): Promise<string> };
  published: {
    get(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined>;
    save(workspace: PublishedWorkspace): Promise<void>;
  };
  waiting?: {
    branches: { list(): Promise<Branch[]> };
    leaves: { list(): Promise<Leaf[]>; save(leaf: Leaf): Promise<void> };
    tasks: { list(ownerId: string): Promise<Task[]>; save(task: Task): Promise<void> };
    grow(ownerId: string, treeId: string): Promise<{ started: boolean }>;
  } | undefined;
  now?: (() => string) | undefined;
}

export interface ComposedPlan {
  base: string;
  fingerprint: string;
  lines: PlanLine[];
  provides: string[];
  env: { name: string; value: string }[];
  baseEnv: { name: string; value: string }[];
}

interface OpenedTree {
  id: string;
  name: string;
  projectId?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const ownerOf = (request: NodeRequest): string => request.run.launch.ownerId;

const textIn = (request: NodeRequest, name: string): string | undefined => {
  const wired = request.inputs[name];
  if (typeof wired === 'string' && wired) return wired;
  const started = request.run.inputs[name];
  return typeof started === 'string' && started ? started : undefined;
};

function treeFrom(request: NodeRequest): OpenedTree {
  const tree = request.inputs.tree;
  if (!isRecord(tree) || typeof tree.id !== 'string') throw new Error('this needs the tree, as Read Workspace File hands it on');
  return { id: tree.id, name: String(tree.name ?? tree.id), ...(typeof tree.projectId === 'string' ? { projectId: tree.projectId } : {}) };
}

function planFrom(request: NodeRequest): ComposedPlan {
  const plan = request.inputs.plan;
  if (!isRecord(plan) || typeof plan.fingerprint !== 'string' || !Array.isArray(plan.lines)) throw new Error('this needs the plan, as Compose Workspace hands it on');
  return plan as unknown as ComposedPlan;
}

const lineKey = (line: PlanLine): string => JSON.stringify([line.from, line.install]);

const sameEnv = (a: readonly { name: string; value: string }[], b: readonly { name: string; value: string }[]): boolean =>
  JSON.stringify([...a].sort((x, y) => x.name.localeCompare(y.name))) === JSON.stringify([...b].sort((x, y) => x.name.localeCompare(y.name)));

export function changesFrom(plan: ComposedPlan, published: PublishedWorkspace | undefined): { changed: boolean; added: PlanLine[]; script?: string | undefined; summary: string } {
  const before = new Set((published?.lines ?? []).map(lineKey));
  const added = plan.lines.filter((line) => !before.has(lineKey(line)));
  const removed = (published?.lines ?? []).filter((line) => !plan.lines.some((own) => lineKey(own) === lineKey(line)));
  const envChanged = !published || !sameEnv(plan.env, published.env);
  const changed = !published || published.fingerprint !== plan.fingerprint || envChanged;
  const script = added.find((line) => line.install.via === 'script' && line.from === 'project');
  const parts = [
    ...(added.length ? [`adds ${added.map(describeLine).join('; ')}`] : []),
    ...(removed.length ? [`drops ${removed.map(describeLine).join('; ')}`] : []),
    ...(published && envChanged ? ['changes its environment values'] : []),
  ];
  return {
    changed,
    added,
    ...(script && script.install.via === 'script' ? { script: script.install.run } : {}),
    summary: parts.join(', ') || (published ? 'nothing changes' : 'its first workspace'),
  };
}

export function createWorkspaceOperations(deps: WorkspaceOperationDeps): Record<string, HostOperationRun> {
  const now = deps.now ?? (() => new Date().toISOString());

  const recordNext = async (request: NodeRequest, treeId: string, stage: NextStage, reason?: string | undefined): Promise<NextWorkspace> => {
    const ownerId = ownerOf(request);
    const commit = textIn(request, 'commit');
    const next: NextWorkspace = { runId: request.run.identity.runId, ...(commit ? { commit } : {}), stage, ...(reason ? { reason } : {}), at: now() };
    const current = await deps.published.get(ownerId, treeId);
    if (current) await deps.published.save({ ...current, next });
    return next;
  };

  const parkedOf = async (ownerId: string, treeId: string): Promise<Leaf[]> => {
    if (!deps.waiting) return [];
    const branchIds = new Set((await deps.waiting.branches.list()).filter((branch) => branch.treeId === treeId && branch.ownerId === ownerId).map((branch) => branch.id));
    return (await deps.waiting.leaves.list()).filter((leaf) => branchIds.has(leaf.branchId) && leaf.ownerId === ownerId && leaf.waitingFor);
  };

  const markStuck = async (ownerId: string, treeId: string, stuck: string | undefined): Promise<void> => {
    for (const leaf of await parkedOf(ownerId, treeId)) {
      const { stuck: was, ...waitingFor } = leaf.waitingFor!;
      if (was === stuck) continue;
      await deps.waiting!.leaves.save({ ...leaf, waitingFor: { ...waitingFor, ...(stuck ? { stuck } : {}) }, updatedAt: now() });
    }
  };

  return {
    async 'workspace.read'(request): Promise<StepResult> {
      const ownerId = ownerOf(request);
      const treeId = textIn(request, 'treeId');
      if (!treeId) return { exit: 'unreadable', outputs: { reason: 'no treeId was wired in, and the run was not started with one' } };
      const tree = (await deps.trees.list()).find((entry) => entry.id === treeId && entry.ownerId === ownerId);
      if (!tree) return { exit: 'unreadable', outputs: { reason: `there is no tree "${treeId}"` } };
      const opened = { id: tree.id, name: tree.name, ...(tree.projectIds?.[0] ? { projectId: tree.projectIds[0] } : {}) };
      const commit = textIn(request, 'commit');
      let text: string | undefined;
      try {
        text = await deps.readFile(ownerId, tree.id);
      } catch (err) {
        return { exit: 'unreadable', outputs: { tree: opened, reason: `the tree's repository could not be read: ${(err as Error).message}` } };
      }
      const read = readWorkspaceFile(text);
      if ('problems' in read) return { exit: 'unreadable', outputs: { tree: opened, reason: read.problems.join('; ') } };
      return { exit: 'read', outputs: { tree: opened, file: read.file, ...(commit ? { commit } : {}) } };
    },

    async 'workspace.compose'(request): Promise<StepResult> {
      const ownerId = ownerOf(request);
      const tree = treeFrom(request);
      const file = isRecord(request.inputs.file) ? request.inputs.file as WorkspaceFile : undefined;
      let composed: ComposedWorkspace;
      try {
        composed = await deps.compose({ treeId: tree.id, ownerId, agents: await deps.agentsFor(ownerId, tree.id), ...(file ? { file } : {}) });
      } catch (err) {
        return { exit: 'unbuildable', outputs: { reason: (err as Error).message } };
      }
      const plan: ComposedPlan = {
        base: composed.plan.base,
        fingerprint: composed.plan.fingerprint,
        lines: composed.plan.lines ?? [],
        provides: composed.plan.provides,
        env: composed.env,
        baseEnv: composed.plan.env ?? [],
      };
      const changes = changesFrom(plan, await deps.published.get(ownerId, tree.id));
      if (changes.changed) {
        await recordNext(request, tree.id, 'building');
        await markStuck(ownerId, tree.id, undefined);
      }
      return {
        exit: changes.changed ? 'changed' : 'unchanged',
        outputs: { plan, added: changes.added, script: changes.script ?? '', summary: changes.summary },
      };
    },

    async 'workspace.build'(request): Promise<StepResult> {
      const plan = planFrom(request);
      try {
        const image = await deps.images.ensure({
          base: plan.base,
          installs: plan.lines.map((line) => line.install),
          lines: plan.lines,
          provides: plan.provides,
          fingerprint: plan.fingerprint,
          ...(plan.baseEnv.length ? { env: plan.baseEnv } : {}),
        });
        return { exit: 'built', outputs: { image } };
      } catch (err) {
        return { exit: 'failed', outputs: { reason: (err as Error).message } };
      }
    },

    async 'workspace.publish'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const plan = planFrom(request);
      const image = request.inputs.image;
      if (typeof image !== 'string' || !image) throw new Error('this needs the image Build Workspace Image built');
      const commit = textIn(request, 'commit');
      const file = isRecord(request.inputs.file) ? request.inputs.file as WorkspaceFile : {};
      const published: PublishedWorkspace = {
        ownerId: ownerOf(request),
        treeId: tree.id,
        ...(commit ? { commit } : {}),
        file,
        fingerprint: plan.fingerprint,
        image,
        provides: plan.provides,
        lines: plan.lines,
        env: plan.env,
        baseEnv: plan.baseEnv,
        publishedAt: now(),
        runId: request.run.identity.runId,
      };
      await deps.published.save(published);
      return { exit: 'published', outputs: { published } };
    },

    async 'workspace.resume'(request): Promise<StepResult> {
      const tree = treeFrom(request);
      const ownerId = ownerOf(request);
      if (!deps.waiting) return { exit: 'none', outputs: { resumed: [] } };
      const parked = await parkedOf(ownerId, tree.id);
      const leafIds = new Set(parked.map((leaf) => leaf.id));
      const at = now();
      for (const task of (await deps.waiting.tasks.list(ownerId)).filter((entry) => entry.status === 'waiting' && entry.leafId && leafIds.has(entry.leafId))) {
        await deps.waiting.tasks.save({ ...task, status: 'accepted', updatedAt: at });
      }
      for (const leaf of parked) {
        const { waitingFor: _waitingFor, ...rest } = leaf;
        await deps.waiting.leaves.save({ ...rest, updatedAt: at });
      }
      if (parked.length === 0) return { exit: 'none', outputs: { resumed: [] } };
      await deps.waiting.grow(ownerId, tree.id);
      return { exit: 'resumed', outputs: { resumed: parked.map((leaf) => leaf.title) } };
    },

    async 'workspace.notify'(request): Promise<StepResult> {
      if (!isRecord(request.inputs.tree)) return { exit: 'told', outputs: {} };
      const tree = treeFrom(request);
      const what = String(request.node.settings.what ?? 'ready') as WorkspaceNoticeKind;
      const summary = typeof request.inputs.summary === 'string' && request.inputs.summary ? request.inputs.summary : undefined;
      const reason = typeof request.inputs.reason === 'string' && request.inputs.reason ? request.inputs.reason : undefined;
      const notice = workspaceNotice(what, tree, { runId: request.run.identity.runId, ...(summary ? { summary } : {}), ...(reason ? { reason } : {}) });
      request.run.emit({ type: 'notice', level: what === 'ready' ? 'info' : 'warn', nodeId: request.node.id, message: notice.text, post: { ...notice } } as never);
      if (what === 'ready') return { exit: 'told', outputs: {} };
      const next = await recordNext(request, tree.id, what, reason);
      if (what === 'failed' || what === 'declined') await markStuck(ownerOf(request), tree.id, stageText(next));
      return { exit: 'told', outputs: {} };
    },
  };
}
