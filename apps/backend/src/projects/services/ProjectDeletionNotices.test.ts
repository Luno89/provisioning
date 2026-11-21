import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { deletionBegun, workClosed, workStopping } from '../lib/project-deletion.js';
import { ProjectDeletionNotices, type ProjectDeletionEvent } from './ProjectDeletionNotices.js';

const at = '2026-11-21T10:00:00.000Z';
const run = { workflowId: 'grove-run-t1', type: 'AgentRunWorkflow', startedAt: at };

async function setUp() {
  const db = memoryDatabase();
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', appType: 'gitapp', createdAt: at });
  await db.projects.markDeleting('p1', { startedAt: at, requestedBy: 'ann', mode: 'archive' });
  const told: { ownerId: string; event: ProjectDeletionEvent }[] = [];
  let tree = 'Grow the tree';
  const notices = new ProjectDeletionNotices({
    store: db.projects,
    titles: async () => (work) => (work.workflowId === 'grove-run-t1' ? `Tree run: ${tree}` : work.type),
    emit: (ownerId, event) => { told.push({ ownerId, event }); },
  });
  return { db, told, notices, renameTree: (name: string) => { tree = name; } };
}

describe('telling the person where their project\'s deletion stands', () => {
  it('names each running thing, keeps it with the project\'s mark and tells the owner\'s browsers', async () => {
    const { db, told, notices } = await setUp();
    const stopping = workStopping(deletionBegun(), [run]);
    await notices.changed({ ownerId: 'ann', projectId: 'p1', progress: stopping });
    expect(told).toEqual([{ ownerId: 'ann', event: { projectId: 'p1', progress: { ...stopping, work: [{ ...run, state: 'stopping', what: 'Tree run: Grow the tree' }] } } }]);
    expect((await db.projects.deletion('p1'))?.progress?.work[0]?.what).toBe('Tree run: Grow the tree');
  });

  it('keeps the name it gave first once the records it was read from are gone', async () => {
    const { told, notices, renameTree } = await setUp();
    const stopping = workStopping(deletionBegun(), [run]);
    await notices.changed({ ownerId: 'ann', projectId: 'p1', progress: stopping });
    renameTree('a tree that is gone');
    await notices.changed({ ownerId: 'ann', projectId: 'p1', progress: workClosed(stopping, 'grove-run-t1', []) });
    expect(told.at(-1)?.event.progress.work[0]).toMatchObject({ state: 'stopped', what: 'Tree run: Grow the tree' });
  });

  it('tells nothing for a copy older than what it already told', async () => {
    const { told, notices } = await setUp();
    const stopping = workStopping(deletionBegun(), [run]);
    await notices.changed({ ownerId: 'ann', projectId: 'p1', progress: workClosed(stopping, 'grove-run-t1', []) });
    await notices.changed({ ownerId: 'ann', projectId: 'p1', progress: stopping });
    expect(told.map((entry) => entry.event.progress.seq)).toEqual([2]);
  });

  it('still tells the owner once the project\'s record is gone, which is its deletion ending', async () => {
    const { db, told, notices } = await setUp();
    await db.projects.removeProjectRecords('p1');
    await notices.changed({ ownerId: 'ann', projectId: 'p1', progress: { ...deletionBegun(), seq: 9, phase: 'deleted' } });
    expect(told.map((entry) => entry.event.progress.phase)).toEqual(['deleted']);
  });
});
