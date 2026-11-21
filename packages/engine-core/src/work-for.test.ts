import { describe, expect, it, vi } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { WorkStopped, carryWorkFor, refusingDeletingWork, stoppedBy, unnamedWork, workFor, workFromHeaders, workHeader, WORK_HEADER, withWorkFor, workIsUnnamed } from './work-for.js';

const run = (headers: Record<string, unknown>) => {
  const { inbound } = carryWorkFor()();
  return inbound.execute({ headers } as never, async () => ({ work: workFor(), unnamed: workIsUnnamed() }));
};

describe('whose work this is, carried with each piece of work', () => {
  it('names the owner and the project the header names, inside the activity and nowhere else', async () => {
    expect(await run({ [WORK_HEADER]: workHeader({ owner: 'u1', project: 'p1' }) })).toEqual({ work: { owner: 'u1', project: 'p1' }, unnamed: false });
    expect(workFor()).toBeUndefined();
  });

  it('marks an activity whose workflow named no work as unnamed, which a removal\'s own steps are', async () => {
    expect(await run({})).toEqual({ work: undefined, unnamed: true });
  });

  it('reads back exactly what it wrote, leaving out what was not named', () => {
    expect(workFromHeaders({ [WORK_HEADER]: workHeader({ owner: 'u1' }) })).toEqual({ owner: 'u1' });
    expect(workFromHeaders({})).toBeUndefined();
  });

  it('adds a project to the work it is in, keeping its owner', async () => {
    const seen = await withWorkFor({ owner: 'u1' }, () => withWorkFor({ project: 'p1' }, async () => workFor()));
    expect(seen).toEqual({ owner: 'u1', project: 'p1' });
  });

  it('names nothing when given nothing to name, leaving the work it is in as it was', async () => {
    expect(await withWorkFor({ project: undefined }, async () => workFor())).toBeUndefined();
    expect(await unnamedWork(() => withWorkFor({ project: undefined }, async () => workIsUnnamed()))).toBe(true);
  });

  it('keeps a removal\'s own steps unnamed whatever project they come to touch, so its own deletions are never refused', async () => {
    expect(await unnamedWork(() => withWorkFor({ project: 'p1' }, async () => ({ work: workFor(), unnamed: workIsUnnamed() })))).toEqual({ work: undefined, unnamed: true });
  });

  it('runs a removal\'s own start as unnamed work, whatever work it is called from', async () => {
    const seen = await withWorkFor({ owner: 'u1' }, () => unnamedWork(async () => ({ work: workFor(), unnamed: workIsUnnamed() })));
    expect(seen).toEqual({ work: undefined, unnamed: true });
  });
});

describe('work for a project being deleted, or an account being removed, is refused', () => {
  const marks = (owner: boolean, project: boolean) => async () => ({ owner, project });

  it('names what stops it: the account first, then the project', () => {
    expect(stoppedBy({ owner: 'u1', project: 'p1' }, { owner: true, project: true })).toEqual({ kind: 'owner', id: 'u1' });
    expect(stoppedBy({ owner: 'u1', project: 'p1' }, { owner: false, project: true })).toEqual({ kind: 'project', id: 'p1' });
    expect(stoppedBy({ owner: 'u1', project: 'p1' }, { owner: false, project: false })).toBeUndefined();
  });

  it('lets through the deletion of the very project it names, but not work of an account being removed', () => {
    expect(stoppedBy({ owner: 'u1', project: 'p1', removing: 'project' }, { owner: false, project: true })).toBeUndefined();
    expect(stoppedBy({ owner: 'u1', project: 'p1', removing: 'project' }, { owner: true, project: true })).toEqual({ kind: 'owner', id: 'u1' });
    expect(stoppedBy({ owner: 'u1', project: 'p1', removing: 'owner' }, { owner: true, project: true })).toBeUndefined();
  });

  it('says so in the words the person reads', () => {
    expect(new WorkStopped({ kind: 'project', id: 'p1' }).message).toBe('this project is being deleted');
    expect(new WorkStopped({ kind: 'owner', id: 'u1' }).message).toBe('this account is being removed');
  });

  it('carries that a piece of work is a removal\'s own in its header', () => {
    expect(workFromHeaders({ [WORK_HEADER]: workHeader({ project: 'p1', removing: 'project' }) })).toEqual({ project: 'p1', removing: 'project' });
  });

  const activity = (read: ReturnType<typeof marks>, headers: Record<string, unknown>) => {
    const [refusal] = refusingDeletingWork(read);
    let ran = false;
    const done = refusal!().inbound.execute({ headers } as never, async () => { ran = true; return 'done'; });
    return { done, ran: () => ran };
  };

  it('fails an activity of a project being deleted before it does anything, for good, in those words', async () => {
    const { done, ran } = activity(marks(false, true), { [WORK_HEADER]: workHeader({ owner: 'u1', project: 'p1' }) });
    const failure = await done.catch((err: unknown) => err as ApplicationFailure);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ nonRetryable: true, type: 'WorkStopped', message: 'this project is being deleted' });
    expect(ran()).toBe(false);
  });

  it('runs an activity whose project is open, and one no work names, which reads no marks', async () => {
    expect(await activity(marks(false, false), { [WORK_HEADER]: workHeader({ owner: 'u1', project: 'p1' }) }).done).toBe('done');
    const read = vi.fn(marks(true, true));
    expect(await activity(read, {}).done).toBe('done');
    expect(read).not.toHaveBeenCalled();
  });

  it('adds no refusal on a worker that cannot read the marks, which says why', () => {
    expect(refusingDeletingWork({ unread: 'a machine reads no marks' })).toEqual([]);
  });
});
