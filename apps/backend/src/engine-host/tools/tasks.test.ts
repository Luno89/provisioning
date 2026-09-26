import { describe, it, expect } from 'vitest';
import { abandonedBy, type Task } from './tasks.js';

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  ownerId: 'u1', title: over.id, doneMeans: 'it works', dependsOn: [], status: 'running', runs: ['run-1'],
  createdAt: 'then', updatedAt: 'then', ...over,
});

describe('abandonedBy', () => {
  const tasks = [task({ id: 'mine' }), task({ id: 'earlier-run', runs: ['run-1', 'run-2'] }), task({ id: 'done', status: 'done' })];

  it('fails the tasks a run left running when the run failed', () => {
    const left = abandonedBy(tasks, 'run-1', 'failed', 'failed — the model could not be reached', 'now');
    expect(left.map((entry) => [entry.id, entry.status])).toEqual([['mine', 'failed']]);
    expect(left[0]!.evidence).toContain('ended without recording an outcome: failed — the model could not be reached');
  });

  it('puts them back to be worked again when the run was stopped, without counting a failure', () => {
    const left = abandonedBy(tasks, 'run-1', 'interrupted', 'interrupted — the run was cancelled', 'now');
    expect(left.map((entry) => [entry.id, entry.status])).toEqual([['mine', 'accepted']]);
    expect(left[0]!.evidence).toContain('stopped before it finished');
  });
});
