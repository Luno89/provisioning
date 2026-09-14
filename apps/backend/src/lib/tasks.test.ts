import { describe, it, expect } from 'vitest';
import {
  blockedBy,
  danglingDependencies,
  describeProblem,
  findCycle,
  isReady,
  newTask,
  readyTasks,
  unblockedBy,
  withRun,
  withStatus,
  type Task,
} from './tasks.js';

const now = '2026-01-01T00:00:00.000Z';

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  ownerId: 'user-1',
  title: 'Do the thing',
  doneMeans: 'the thing is done',
  dependsOn: [],
  status: 'accepted',
  runs: [],
  createdAt: now,
  updatedAt: now,
  ...over,
});

describe('proposing a task', () => {
  it('insists on a title and on saying what done means', () => {
    expect(describeProblem({ title: '', doneMeans: 'x' })).toContain('needs a title');
    expect(describeProblem({ title: 'x', doneMeans: '  ' })).toContain('"done" means');
    expect(describeProblem({ title: 'x', doneMeans: 'y' })).toBeUndefined();
  });

  it('rejects absurd lengths rather than storing them', () => {
    expect(describeProblem({ title: 'x'.repeat(500), doneMeans: 'y' })).toContain('under 200');
    expect(describeProblem({ title: 'x', doneMeans: 'y'.repeat(5_000) })).toContain('under 2000');
  });

  it('starts life proposed, with nothing run against it yet', () => {
    const made = newTask({ id: 't1', ownerId: 'user-1', title: ' Ship it ', doneMeans: ' it ships ' }, now);

    expect(made).toMatchObject({ status: 'proposed', runs: [], title: 'Ship it', doneMeans: 'it ships' });
    expect(made.dependsOn).toEqual([]);
  });

  it('keeps optional detail only when it was given', () => {
    const bare = newTask({ id: 't1', ownerId: 'user-1', title: 'a', doneMeans: 'b' }, now);
    expect(bare.intent).toBeUndefined();
    expect(bare.agent).toBeUndefined();
    expect(bare.checks).toBeUndefined();

    const full = newTask({
      id: 't2', ownerId: 'user-1', title: 'a', doneMeans: 'b',
      intent: 'because', agent: 'executor', checks: { command: 'npm test' }, dependsOn: ['t1'],
    }, now);

    expect(full).toMatchObject({ intent: 'because', agent: 'executor', dependsOn: ['t1'] });
    expect(full.checks?.command).toBe('npm test');
  });
});

describe('readiness', () => {
  it('is ready when accepted with no dependencies', () => {
    const one = task({ id: 't1' });
    expect(isReady(one, [one])).toBe(true);
  });

  it('is not ready while still only proposed', () => {
    const one = task({ id: 't1', status: 'proposed' });
    expect(isReady(one, [one])).toBe(false);
  });

  it('is not ready while a dependency is outstanding', () => {
    const first = task({ id: 't1', status: 'running' });
    const second = task({ id: 't2', dependsOn: ['t1'] });

    expect(blockedBy(second, [first, second])).toHaveLength(1);
    expect(isReady(second, [first, second])).toBe(false);
  });

  it('becomes ready once every dependency is done', () => {
    const first = task({ id: 't1', status: 'done' });
    const second = task({ id: 't2', status: 'done' });
    const third = task({ id: 't3', dependsOn: ['t1', 't2'] });

    expect(isReady(third, [first, second, third])).toBe(true);
  });

  it('treats a dropped dependency as still blocking, since it never happened', () => {
    const dropped = task({ id: 't1', status: 'dropped' });
    const waiting = task({ id: 't2', dependsOn: ['t1'] });

    expect(isReady(waiting, [dropped, waiting])).toBe(false);
  });

  it('refuses to start something that depends on a task nobody has heard of', () => {
    const orphan = task({ id: 't2', dependsOn: ['ghost'] });

    expect(danglingDependencies(orphan, [orphan])).toEqual(['ghost']);
    expect(isReady(orphan, [orphan])).toBe(false);
  });

  it('lists everything currently startable', () => {
    const all = [
      task({ id: 't1', status: 'done' }),
      task({ id: 't2', dependsOn: ['t1'] }),
      task({ id: 't3', status: 'proposed' }),
      task({ id: 't4', dependsOn: ['t3'] }),
    ];

    expect(readyTasks(all).map((t) => t.id)).toEqual(['t2']);
  });
});

describe('what finishing a task unblocks', () => {
  it('returns exactly what that task was holding up', () => {
    const all = [
      task({ id: 't1', status: 'done' }),
      task({ id: 't2', dependsOn: ['t1'] }),
      task({ id: 't3', dependsOn: ['t1'] }),
      task({ id: 't4' }),
    ];

    expect(unblockedBy('t1', all).map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('does not start something still waiting on another dependency', () => {
    const all = [
      task({ id: 't1', status: 'done' }),
      task({ id: 't2', status: 'running' }),
      task({ id: 't3', dependsOn: ['t1', 't2'] }),
    ];

    expect(unblockedBy('t1', all)).toEqual([]);
  });

  it('does not re-start work that is already running or finished', () => {
    const all = [
      task({ id: 't1', status: 'done' }),
      task({ id: 't2', dependsOn: ['t1'], status: 'running' }),
      task({ id: 't3', dependsOn: ['t1'], status: 'done' }),
    ];

    expect(unblockedBy('t1', all)).toEqual([]);
  });

  it('leaves proposed work alone until somebody accepts it', () => {
    const all = [
      task({ id: 't1', status: 'done' }),
      task({ id: 't2', dependsOn: ['t1'], status: 'proposed' }),
    ];

    expect(unblockedBy('t1', all)).toEqual([]);
  });
});

describe('transitions', () => {
  it('records a status change with the time it happened', () => {
    const moved = withStatus(task({ id: 't1' }), 'running', '2026-02-02T00:00:00.000Z');

    expect(moved).toMatchObject({ status: 'running', updatedAt: '2026-02-02T00:00:00.000Z' });
  });

  it('keeps every attempt against a task, without duplicates', () => {
    const once = withRun(task({ id: 't1' }), 'run-1', now);
    const twice = withRun(once, 'run-1', now);
    const again = withRun(twice, 'run-2', now);

    expect(again.runs).toEqual(['run-1', 'run-2']);
  });
});

describe('cycles', () => {
  it('finds nothing in a plain chain', () => {
    const all = [
      task({ id: 't1' }),
      task({ id: 't2', dependsOn: ['t1'] }),
      task({ id: 't3', dependsOn: ['t2'] }),
    ];

    expect(findCycle(all).hasCycle).toBe(false);
  });

  it('catches work that waits on itself', () => {
    const all = [
      task({ id: 't1', dependsOn: ['t2'] }),
      task({ id: 't2', dependsOn: ['t1'] }),
    ];

    const report = findCycle(all);
    expect(report.hasCycle).toBe(true);
    expect(report.members.length).toBeGreaterThan(1);
  });

  it('catches a longer loop', () => {
    const all = [
      task({ id: 't1', dependsOn: ['t3'] }),
      task({ id: 't2', dependsOn: ['t1'] }),
      task({ id: 't3', dependsOn: ['t2'] }),
    ];

    expect(findCycle(all).hasCycle).toBe(true);
  });
});
