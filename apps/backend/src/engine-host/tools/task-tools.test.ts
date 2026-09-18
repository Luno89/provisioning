import { describe, it, expect, beforeEach } from 'vitest';
import { createTaskTools, type TaskStore } from './task-tools.js';
import type { Task } from '../tools/tasks.js';

let stored: Task[] = [];
let nextId = 0;

const store: TaskStore = {
  list: async (ownerId: string) => stored.filter((task) => task.ownerId === ownerId),
  save: async (task: Task) => {
    const index = stored.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) stored[index] = task;
    else stored.push(task);
  },
};

const tools = () => createTaskTools({
  store,
  newId: () => `t${++nextId}`,
  now: () => '2026-01-01T00:00:00.000Z',
});

const caller = { ownerId: 'user-1', projectId: 'project-9', runId: 'run-1', agentSlug: 'planner' };

const run = (
  name: string,
  parsed: Record<string, unknown>,
  over: Partial<Record<keyof typeof caller, string | undefined>> = {},
) => tools()[name]!({ name, parsed, driver: undefined, caller: { ...caller, ...over } });

const seed = (over: Partial<Task> & Pick<Task, 'id'>): Task => {
  const task: Task = {
    ownerId: 'user-1',
    title: 'Seeded',
    doneMeans: 'it works',
    dependsOn: [],
    status: 'accepted',
    runs: [],
    createdAt: 'now',
    updatedAt: 'now',
    ...over,
  };
  stored.push(task);
  return task;
};

beforeEach(() => {
  stored = [];
  nextId = 0;
});

describe('propose_work', () => {
  it('creates work in proposed state, owned and scoped to the project', async () => {
    const outcome = await run('propose_work', {
      title: 'Point Odoo at the right database',
      doneMeans: 'the pod stops crash-looping and serves a page',
      intent: 'it cannot resolve host "db"',
    });

    expect(outcome.ok).toBe(true);
    expect(stored[0]).toMatchObject({
      title: 'Point Odoo at the right database',
      status: 'proposed',
      ownerId: 'user-1',
      projectId: 'project-9',
    });
  });

  it('insists the model says what done means', async () => {
    const outcome = await run('propose_work', { title: 'Do something vague' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('"done" means');
    expect(stored).toHaveLength(0);
  });

  it('accepts the snake_case spelling models often produce', async () => {
    const outcome = await run('propose_work', { title: 'A', done_means: 'B', depends_on: [] });
    expect(outcome.ok).toBe(true);
  });

  it('records dependencies and checks when given', async () => {
    seed({ id: 'existing' });

    await run('propose_work', {
      title: 'Run the tests',
      doneMeans: 'they pass',
      dependsOn: ['existing'],
      agent: 'executor',
      checks: { command: 'npm test', expects: ['coverage/'] },
    });

    expect(stored.at(-1)).toMatchObject({ dependsOn: ['existing'], agent: 'executor' });
    expect(stored.at(-1)?.checks).toEqual({ command: 'npm test', expects: ['coverage/'] });
  });

  it('refuses to depend on work that does not exist', async () => {
    const outcome = await run('propose_work', { title: 'A', doneMeans: 'B', dependsOn: ['ghost'] });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('do not exist');
    expect(stored).toHaveLength(0);
  });

  it('refuses to create work that would wait on itself', async () => {
    seed({ id: 'a', dependsOn: ['t1'] });

    const outcome = await run('propose_work', { title: 'B', doneMeans: 'C', dependsOn: ['a'] });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('wait on itself');
    expect(stored).toHaveLength(1);
  });
});

describe('list_tasks', () => {
  it('lists work in a form a model can act on', async () => {
    seed({ id: 'a', title: 'First', status: 'proposed' });
    seed({ id: 'b', title: 'Second', status: 'done' });

    const outcome = await run('list_tasks', {});

    expect(outcome.digest).toContain('a — First [proposed]');
    expect(outcome.digest).toContain('b — Second [done]');
  });

  it('filters by status', async () => {
    seed({ id: 'a', status: 'proposed' });
    seed({ id: 'b', status: 'done' });

    const outcome = await run('list_tasks', { status: 'proposed' });

    expect(outcome.digest).toContain('a');
    expect(outcome.digest).not.toContain('b —');
  });

  it('says plainly when there is nothing', async () => {
    expect((await run('list_tasks', {})).digest).toBe('no work yet');
  });

  it('never shows another owner their work', async () => {
    seed({ id: 'mine' });
    stored.push({
      id: 'theirs', ownerId: 'user-2', title: 'Not yours', doneMeans: 'x',
      dependsOn: [], status: 'accepted', runs: [], createdAt: 'now', updatedAt: 'now',
    });

    const outcome = await run('list_tasks', {});
    expect(outcome.digest).not.toContain('theirs');
  });
});

describe('the lifecycle primitives', () => {
  it('accepts proposed work', async () => {
    seed({ id: 'a', status: 'proposed' });

    const outcome = await run('accept_task', { taskId: 'a' });

    expect(outcome.ok).toBe(true);
    expect(stored[0]?.status).toBe('accepted');
  });

  it('starts work and records which run is doing it', async () => {
    seed({ id: 'a' });

    await run('start_task', { taskId: 'a' });

    expect(stored[0]).toMatchObject({ status: 'running', runs: ['run-1'] });
  });

  it('records failure with a reason', async () => {
    seed({ id: 'a', status: 'running' });

    await run('mark_failed', { taskId: 'a', reason: 'the build never went green' });

    expect(stored[0]).toMatchObject({ status: 'failed', evidence: 'the build never went green' });
  });

  it('drops work without pretending it happened', async () => {
    seed({ id: 'a', status: 'proposed' });

    await run('drop_task', { taskId: 'a', reason: 'not needed after all' });

    expect(stored[0]).toMatchObject({ status: 'dropped' });
  });

  it('says which task it cannot find', async () => {
    const outcome = await run('accept_task', { taskId: 'ghost' });

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toContain('no task called "ghost"');
  });

  it('needs a taskId rather than guessing', async () => {
    expect((await run('mark_done', {})).digest).toContain('needs a "taskId"');
  });
});

describe('mark_done reports exactly what it unblocked', () => {
  it('names the work that just became startable', async () => {
    seed({ id: 'a', title: 'Groundwork', status: 'running' });
    seed({ id: 'b', title: 'Depends on groundwork', dependsOn: ['a'], agent: 'executor' });

    const outcome = await run('mark_done', { taskId: 'a', evidence: 'migration applied' });

    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toContain('this unblocked');
    expect(outcome.digest).toContain('Depends on groundwork');
    expect(JSON.parse(outcome.content!).unblocked).toEqual([
      { id: 'b', title: 'Depends on groundwork', agent: 'executor' },
    ]);
  });

  it('says nothing was waiting when nothing was', async () => {
    seed({ id: 'a', status: 'running' });

    const outcome = await run('mark_done', { taskId: 'a' });

    expect(outcome.digest).toContain('nothing was waiting on it');
    expect(JSON.parse(outcome.content!).unblocked).toEqual([]);
  });

  it('does not report work still waiting on something else', async () => {
    seed({ id: 'a', status: 'running' });
    seed({ id: 'b', status: 'running' });
    seed({ id: 'c', dependsOn: ['a', 'b'] });

    const outcome = await run('mark_done', { taskId: 'a' });

    expect(JSON.parse(outcome.content!).unblocked).toEqual([]);
  });

  it('does not report work nobody has accepted yet', async () => {
    seed({ id: 'a', status: 'running' });
    seed({ id: 'b', dependsOn: ['a'], status: 'proposed' });

    expect(JSON.parse((await run('mark_done', { taskId: 'a' })).content!).unblocked).toEqual([]);
  });

  it('keeps the evidence it was given', async () => {
    seed({ id: 'a', status: 'running' });

    await run('mark_done', { taskId: 'a', evidence: 'tests pass, pod is healthy' });

    expect(stored[0]?.evidence).toBe('tests pass, pod is healthy');
  });
});

describe('ownership', () => {
  it('refuses every call from a run with no owner', async () => {
    for (const name of ['propose_work', 'list_tasks', 'accept_task', 'start_task', 'mark_done', 'mark_failed', 'drop_task']) {
      const outcome = await run(name, { taskId: 'a', title: 'x', doneMeans: 'y' }, { ownerId: undefined });
      expect(outcome.ok).toBe(false);
    }
  });
});
