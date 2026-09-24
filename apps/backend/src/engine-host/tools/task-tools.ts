import { v4 as uuidv4 } from 'uuid';
import { leafContextLine } from '../../lib/plan-documents.js';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import {
  describeProblem,
  findCycle,
  newTask,
  readyTasks,
  unblockedBy,
  withRun,
  withStatus,
  type Task,
  type TaskChecks,
  type TaskStatus,
} from '../tools/tasks.js';

export interface TaskStore {
  list(ownerId: string): Promise<Task[]>;
  save(task: Task): Promise<void>;
}

export interface TaskToolOptions {
  store: TaskStore;
  newId?: (() => string) | undefined;
  now?: (() => string) | undefined;
}

export type TaskToolsOptions = TaskToolOptions;

const refuse = (why: string): ToolOutcome => ({ ok: false, digest: why, content: why });

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const asStringList = (parsed: Record<string, unknown>, key: string): string[] => {
  const value = parsed[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
};

const asChecks = (parsed: Record<string, unknown>): TaskChecks | undefined => {
  const raw = parsed.checks;
  if (!raw || typeof raw !== 'object') return undefined;

  const record = raw as Record<string, unknown>;
  const command = typeof record.command === 'string' && record.command.trim() ? record.command.trim() : undefined;
  const expects = Array.isArray(record.expects)
    ? record.expects.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

  const flat: Record<string, unknown> = {};
  for (const key of ['fileExists', 'contentPath', 'contentPattern', 'httpUrl'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) flat[key] = value.trim();
  }
  const httpStatus = typeof record.httpStatus === 'number' ? record.httpStatus : undefined;

  if (!command && !expects?.length && Object.keys(flat).length === 0 && httpStatus === undefined) return undefined;
  return { ...(command ? { command } : {}), ...(expects?.length ? { expects } : {}), ...flat, ...(httpStatus !== undefined ? { httpStatus } : {}) };
};

const summarise = (task: Task): string =>
  `${task.id} — ${task.title} [${task.status}]${task.agent ? ` · ${task.agent}` : ''}`;

export function createTaskTools(options: TaskToolOptions): Record<string, ToolHandler> {
  const newId = options.newId ?? (() => uuidv4());
  const now = options.now ?? (() => new Date().toISOString());

  const settle = async (
    parsed: Record<string, unknown>,
    ownerId: string,
    status: TaskStatus,
    evidenceKey = 'evidence',
  ): Promise<{ task: Task; all: Task[] } | ToolOutcome> => {
    const taskId = asString(parsed, 'taskId') ?? asString(parsed, 'id');
    if (!taskId) return refuse('this call needs a "taskId"');

    const all = await options.store.list(ownerId);
    const task = all.find((candidate) => candidate.id === taskId);
    if (!task) return refuse(`there is no task called "${taskId}"`);

    const evidence = asString(parsed, evidenceKey);
    const updated: Task = {
      ...withStatus(task, status, now()),
      ...(evidence ? { evidence } : {}),
    };

    await options.store.save(updated);
    return { task: updated, all: all.map((entry) => (entry.id === updated.id ? updated : entry)) };
  };

  return {
    async propose_work({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to propose work for');

      const input = {
        title: asString(parsed, 'title') ?? '',
        doneMeans: asString(parsed, 'doneMeans') ?? asString(parsed, 'done_means') ?? '',
        ...(asString(parsed, 'leafId') ?? asString(parsed, 'leaf_id') ? { leafId: (asString(parsed, 'leafId') ?? asString(parsed, 'leaf_id'))! } : {}),
        ...(asString(parsed, 'intent') ? { intent: asString(parsed, 'intent') } : {}),
        ...(asString(parsed, 'description') ? { description: asString(parsed, 'description') } : {}),
        ...(asString(parsed, 'role') ? { role: asString(parsed, 'role') } : {}),
        ...(asString(parsed, 'agent') ? { agent: asString(parsed, 'agent') } : {}),
        dependsOn: asStringList(parsed, 'dependsOn').concat(asStringList(parsed, 'depends_on')),
        ...(asChecks(parsed) ? { checks: asChecks(parsed) } : {}),
        ...(asString(parsed, 'parentTaskId') ? { parentTaskId: asString(parsed, 'parentTaskId') } : {}),
      };

      const problem = describeProblem(input);
      if (problem) return refuse(problem);

      const all = await options.store.list(caller.ownerId);
      const known = new Set(all.map((task) => task.id));
      const unknown = input.dependsOn.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        return refuse(`these dependencies do not exist: ${unknown.join(', ')}`);
      }

      if (input.leafId) {
        const across = input.dependsOn.filter((id) => {
          const dependency = all.find((candidate) => candidate.id === id);
          return dependency?.leafId !== undefined && dependency.leafId !== input.leafId;
        });
        if (across.length > 0) {
          return refuse(`work under a leaf can only wait on other work in the same leaf: ${across.join(', ')}`);
        }
      }

      const task = newTask({
        ...input,
        id: newId(),
        ownerId: caller.ownerId,
        ...(caller.projectId ? { projectId: caller.projectId } : {}),
      }, now());

      const cycle = findCycle([...all, task]);
      if (cycle.hasCycle) {
        return refuse(`that would make work wait on itself: ${cycle.members.join(' → ')}`);
      }

      await options.store.save(task);

      return {
        ok: true,
        digest: `proposed ${task.id} — ${task.title}`,
        content: JSON.stringify({ taskId: task.id, status: task.status }),
      };
    },

    async list_tasks({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose work it could list');

      const status = asString(parsed, 'status');
      const leafId = asString(parsed, 'leafId') ?? asString(parsed, 'leaf_id');
      const onlyReady = parsed.ready === true;
      const all = await options.store.list(caller.ownerId);

      const chosen = onlyReady
        ? readyTasks(all)
        : (status ? all.filter((task) => task.status === status) : all);
      const filtered = leafId ? chosen.filter((task) => task.leafId === leafId) : chosen;

      if (filtered.length === 0) {
        const nothing = onlyReady ? 'nothing is ready to start' : (status ? `no ${status} work` : 'no work yet');
        return { ok: true, digest: nothing, content: '[]' };
      }

      return {
        ok: true,
        digest: filtered.map(summarise).join('\n'),
        content: JSON.stringify(filtered.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          doneMeans: task.doneMeans,
          dependsOn: task.dependsOn,
          agent: task.agent,
          ...(task.leafId ? { description: task.description, role: task.role, context: leafContextLine(task.leafId) } : {}),
        }))),
      };
    },

    async accept_task({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner');
      const settled = await settle(parsed, caller.ownerId, 'accepted');
      if ('ok' in settled) return settled;

      return {
        ok: true,
        digest: `accepted ${settled.task.id} — ${settled.task.title}`,
        content: JSON.stringify({ taskId: settled.task.id, status: settled.task.status }),
      };
    },

    async start_task({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner');

      const taskId = asString(parsed, 'taskId') ?? asString(parsed, 'id');
      if (!taskId) return refuse('this call needs a "taskId"');

      const all = await options.store.list(caller.ownerId);
      const task = all.find((candidate) => candidate.id === taskId);
      if (!task) return refuse(`there is no task called "${taskId}"`);

      const running = withStatus(
        caller.runId ? withRun(task, caller.runId, now()) : task,
        'running',
        now(),
      );
      await options.store.save(running);

      return {
        ok: true,
        digest: `started ${running.id} — ${running.title}`,
        content: JSON.stringify({ taskId: running.id, runs: running.runs, ...(running.leafId ? { context: leafContextLine(running.leafId) } : {}) }),
      };
    },

    async mark_done({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner');
      const settled = await settle(parsed, caller.ownerId, 'done');
      if ('ok' in settled) return settled;

      const unblocked = unblockedBy(settled.task.id, settled.all);
      const listed = unblocked.length > 0
        ? `\nthis unblocked: ${unblocked.map(summarise).join('; ')}`
        : '\nnothing was waiting on it';

      return {
        ok: true,
        digest: `finished ${settled.task.id} — ${settled.task.title}${listed}`,
        content: JSON.stringify({
          taskId: settled.task.id,
          unblocked: unblocked.map((task) => ({ id: task.id, title: task.title, agent: task.agent })),
        }),
      };
    },

    async mark_failed({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner');
      const settled = await settle(parsed, caller.ownerId, 'failed', 'reason');
      if ('ok' in settled) return settled;

      return {
        ok: true,
        digest: `failed ${settled.task.id} — ${settled.task.title}`,
        content: JSON.stringify({ taskId: settled.task.id, status: 'failed' }),
      };
    },

    async drop_task({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner');
      const settled = await settle(parsed, caller.ownerId, 'dropped', 'reason');
      if ('ok' in settled) return settled;

      return {
        ok: true,
        digest: `dropped ${settled.task.id} — ${settled.task.title}`,
        content: JSON.stringify({ taskId: settled.task.id, status: 'dropped' }),
      };
    },
  };
}
