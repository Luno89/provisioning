import { describe, expect, it } from 'vitest';
import { carryWorkFor, unnamedWork, workFor, workFromHeaders, workHeader, WORK_HEADER, withWorkFor, workIsUnnamed } from './work-for.js';

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

  it('keeps a removal\'s own steps unnamed whatever project they come to touch, so its own deletions are never fenced', async () => {
    expect(await unnamedWork(() => withWorkFor({ project: 'p1' }, async () => ({ work: workFor(), unnamed: workIsUnnamed() })))).toEqual({ work: undefined, unnamed: true });
  });

  it('runs a removal\'s own start as unnamed work, whatever work it is called from', async () => {
    const seen = await withWorkFor({ owner: 'u1' }, () => unnamedWork(async () => ({ work: workFor(), unnamed: workIsUnnamed() })));
    expect(seen).toEqual({ work: undefined, unnamed: true });
  });
});
