import { describe, expect, it, vi } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import { objectWith } from '../../platform/lib/test-matchers.js';
import type { Task } from '../../projects/lib/tasks.js';
import { decideTask, type Accepted, type TaskAccess } from './TaskDecisions.js';

const task = (fields: Partial<Task> = {}): Task => ({ id: 'k1', ownerId: 'ann', title: 'Wire it', doneMeans: 'wired', dependsOn: [], status: 'proposed', runs: [], createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', ...fields });

function tasks(...held: Task[]) {
  const access = mock<TaskAccess>();
  access.list.mockImplementation(async (ownerId) => held.filter((entry) => entry.ownerId === ownerId));
  access.save.mockImplementation(async (saved) => { held.splice(0, held.length, ...held.filter((entry) => entry.id !== saved.id), saved); });
  return access;
}

describe('deciding on a task a run proposed', () => {
  it('accepts a task and saves it as accepted, stamped with when', async () => {
    const access = tasks(task());
    const decided = await decideTask(access, undefined, 'ann', 'k1', 'accepted', '2026-10-22T00:00:00Z');
    expect(decided).toMatchObject({ id: 'k1', status: 'accepted', updatedAt: '2026-10-22T00:00:00Z' });
    expect(access.save).toHaveBeenCalledWith(decided);
  });

  it('drops a task without telling anyone it was accepted', async () => {
    const access = tasks(task());
    const accepted = mockFn(vi.fn<Accepted>());
    const decided = await decideTask(access, accepted, 'ann', 'k1', 'dropped');
    expect(decided?.status).toBe('dropped');
    expect(accepted).not.toHaveBeenCalled();
  });

  it('says there is no such task for one that is not the owner\'s', async () => {
    const access = tasks(task({ ownerId: 'eve' }));
    expect(await decideTask(access, undefined, 'ann', 'k1', 'accepted')).toBeUndefined();
    expect(await decideTask(access, undefined, 'ann', 'nope', 'accepted')).toBeUndefined();
    expect(access.save).not.toHaveBeenCalled();
  });

  it('tells what takes accepted tasks about the accepted one, and keeps what it did to it when the task has to wait', async () => {
    const access = tasks(task());
    const accepted = mockFn(vi.fn<Accepted>());
    accepted.mockImplementation(async (_owner, given) => {
      await access.save({ ...given, status: 'waiting' as never });
      return { waiting: [given.id] };
    });
    const decided = await decideTask(access, accepted, 'ann', 'k1', 'accepted');
    expect(accepted).toHaveBeenCalledWith('ann', objectWith({ id: 'k1', status: 'accepted' }));
    expect(decided?.status).toBe('waiting');
  });

  it('answers with the accepted task when what takes it leaves it as it is', async () => {
    const access = tasks(task());
    const accepted = mockFn(vi.fn<Accepted>());
    accepted.mockResolvedValue({ waiting: [] });
    expect((await decideTask(access, accepted, 'ann', 'k1', 'accepted'))?.status).toBe('accepted');
  });
});
