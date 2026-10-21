import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { WorkspaceChange } from '../../../lib/workspace-file.js';
import type { WorkspaceFileWrite } from '../../../services/WorkspaceFileService.js';
import { withStatus, type Task } from '../../../engine-host/tools/tasks.js';
import { CHANGE_WORKSPACE, MARK_WAITING } from './catalogue.js';

export interface WorkspaceToolDeps {
  files: { change(ownerId: string, treeId: string, change: WorkspaceChange, said: string): Promise<WorkspaceFileWrite> };
  build: (ownerId: string, treeId: string, commit: string) => Promise<{ started: true; runId: string } | { started: false; reason: 'running' | 'switched-off' }>;
  binding?: ((ownerId: string, conversationId: string) => Promise<{ treeId?: string | undefined } | undefined>) | undefined;
  tasks: { list(ownerId: string): Promise<Task[]>; save(task: Task): Promise<void> };
  pending: (ownerId: string, treeId: string) => Promise<string[]>;
  now?: (() => string) | undefined;
}

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const parsedJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
const names = (raw: unknown): string[] | undefined => {
  const value = typeof raw === 'string' && raw.trim().startsWith('[') ? parsedJson(raw) : raw;
  const listed = typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : undefined;
  const kept = listed?.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
  return kept?.length ? kept : undefined;
};

export function changeFrom(parsed: Record<string, unknown>): WorkspaceChange | string {
  const packages = Object.fromEntries((['dnf', 'apt', 'pip', 'npm'] as const).flatMap((manager) => {
    const listed = names(parsed[manager]);
    return listed ? [[manager, listed]] : [];
  }));
  const env = parsedJson(parsed.env);
  if (env !== undefined && !(Array.isArray(env) && env.every((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' && typeof (entry as { value?: unknown }).value === 'string'))) {
    return 'env has to be a list of { name, value }, both text';
  }
  const change: WorkspaceChange = {
    ...(Object.keys(packages).length ? { packages } : {}),
    ...(names(parsed.languages) ? { languages: names(parsed.languages) } : {}),
    ...(Array.isArray(env) && env.length ? { env: env as { name: string; value: string }[] } : {}),
    ...(text(parsed.script) ? { script: text(parsed.script) } : {}),
    ...(names(parsed.needs) ? { needs: names(parsed.needs) } : {}),
  };
  return Object.keys(change).length ? change : 'say what to add: needs, dnf, apt, pip or npm packages, languages, env or a script';
}

export function createWorkspaceTools(deps: WorkspaceToolDeps): Record<string, ToolHandler> {
  const now = deps.now ?? (() => new Date().toISOString());
  const treeOf = async (parsed: Record<string, unknown>, caller: { ownerId?: string | undefined; treeId?: string | undefined; conversationId?: string | undefined }): Promise<string | undefined> => {
    const bound = caller.ownerId && caller.conversationId && deps.binding ? (await deps.binding(caller.ownerId, caller.conversationId))?.treeId : undefined;
    return text(parsed.treeId) ?? caller.treeId ?? bound;
  };
  return {
    async [CHANGE_WORKSPACE]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner');
      const why = text(parsed.why);
      if (!why) return refuse('say why the workspace needs it, in "why": the person reads it in the commit');
      const treeId = await treeOf(parsed, caller);
      if (!treeId) return refuse('this run is not working in a tree, so name the tree with treeId');
      const change = changeFrom(parsed);
      if (typeof change === 'string') return refuse(`${change}; nothing was committed`);

      const written = await deps.files.change(caller.ownerId, treeId, change, `${why}${caller.agentSlug ? `\n\nAsked for by ${caller.agentSlug}${caller.runId ? ` in ${caller.runId}` : ''}.` : ''}`);
      if (!written.ok) return refuse(`${written.why}; nothing was committed`);
      if (!written.written || !written.commit) {
        return { ok: true, digest: 'the workspace has all of it already', content: 'Everything asked for is in .koala/workspace.json already, so nothing was committed. If a command still cannot find it, the workspace with it may not be published yet: carry on with what does not need it.' };
      }

      const build = await deps.build(caller.ownerId, treeId, written.commit);
      const waits = change.script ? ' It carries a new install script, so the build waits for the person to approve it on a card in the project\'s channel.' : '';
      const building = build.started || build.reason === 'running'
        ? `The workspace is being rebuilt.${waits} Nothing added is there until it is published; your run moves onto it at its next command after that, its files kept. Carry on with what does not need it.`
        : 'The workspace extension is switched off for this person, so the workspace is not rebuilt: the file is committed for when it is switched on. Carry on without it.';
      return {
        ok: true,
        digest: `added ${written.added.join('; ')} to the workspace (${written.commit.slice(0, 8)})`,
        content: `Committed ${written.commit.slice(0, 8)} to .koala/workspace.json on main, adding ${written.added.join('; ')}. ${building}`,
      };
    },

    async [MARK_WAITING]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner');
      const taskId = text(parsed.taskId);
      const waitsFor = text(parsed.waitsFor);
      if (!taskId || !waitsFor) return refuse('mark_waiting needs the taskId and what it waitsFor');
      const task = (await deps.tasks.list(caller.ownerId)).find((entry) => entry.id === taskId);
      if (!task) return refuse(`there is no task called "${taskId}"`);
      if (task.status !== 'running' && task.status !== 'accepted' && task.status !== 'waiting') return refuse(`"${task.title}" is ${task.status}, so it cannot wait`);
      const treeId = await treeOf(parsed, caller);
      if (!treeId) return refuse('this run is not working in a tree, so name the tree with treeId');
      const pending = await deps.pending(caller.ownerId, treeId);
      if (pending.length === 0) return refuse('the workspace already has everything .koala/workspace.json asks for, so there is nothing to wait for. If you just asked for it with change_workspace, it is already built: run the command again, and it runs in the rebuilt workspace. Otherwise ask for what is missing with change_workspace, or the command needs something else');

      await deps.tasks.save({ ...withStatus(task, 'waiting', now()), evidence: `waits for the workspace to get ${pending.join('; ')}: ${waitsFor}` });
      return {
        ok: true,
        digest: `"${task.title}" waits for the workspace to get ${pending.join('; ')}`,
        content: `"${task.title}" waits for the workspace to get ${pending.join('; ')}. When nothing else in the story can be done, the story is put aside and put back in line once the workspace is rebuilt. End your turn now, saying what you did and what is left.`,
      };
    },
  };
}
