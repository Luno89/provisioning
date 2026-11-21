import { describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ProjectRemovalService } from './ProjectRemovalService.js';

const now = '2026-10-21T00:00:00Z';

async function setUp() {
  const db = await testDatabase();
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', createdAt: now } as never);
  const started: string[] = [];
  const service = new ProjectRemovalService({
    store: db,
    workflows: { state: async () => ({ state: 'none' as const }), start: async (_workflow: string, id: string) => { started.push(id); } } as never,
    now: () => now,
  });
  return { db, service, started };
}

describe('deleting a project on the instance\'s own database', () => {
  it('marks the project as being removed and starts its removal, once its name is typed', async () => {
    const { db, service, started } = await setUp();
    expect((await service.remove('ann', 'p1', 'Not it')).ok).toBe(false);
    expect(started).toEqual([]);
    expect((await service.remove('ann', 'p1', 'Shop')).ok).toBe(true);
    expect(started).toHaveLength(1);
    expect((await db.projects.getProjects()).find((project) => project.id === 'p1')?.removal).toEqual({ startedAt: now, requestedBy: 'ann' });
  });
});
