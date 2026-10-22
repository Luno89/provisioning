import { describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { ProjectRemovalService } from './ProjectRemovalService.js';

const now = '2026-10-21T00:00:00Z';

async function setUp(shared: boolean) {
  const db = await testDatabase();
  await db.saveProject({ id: 'p1', name: 'Shop', ownerId: 'ann', createdAt: now } as never);
  const started: string[] = [];
  const takenBack: string[] = [];
  const service = new ProjectRemovalService({
    store: db,
    workflows: { state: async () => ({ state: 'none' as const }), start: async (_workflow: string, id: string) => { started.push(id); } } as never,
    hub: { shared: async () => shared, takeBack: async (_owner, projectId) => { takenBack.push(projectId); } },
    now: () => now,
  });
  return { db, service, started, takenBack };
}

describe('deleting a project that is shared on the hub', () => {
  it('says the hub copy goes, and takes it back before the removal starts', async () => {
    const { service, started, takenBack } = await setUp(true);
    const preview = await service.preview('ann', 'p1');
    expect(preview?.sharedOnHub).toBe(true);
    const removed = await service.remove('ann', 'p1', 'Shop');
    expect(removed.ok).toBe(true);
    expect(takenBack).toEqual(['p1']);
    expect(started).toHaveLength(1);
  });

  it('leaves the hub alone for a project that is not shared', async () => {
    const { service, takenBack } = await setUp(false);
    expect((await service.preview('ann', 'p1'))?.sharedOnHub).toBeUndefined();
    await service.remove('ann', 'p1', 'Shop');
    expect(takenBack).toEqual([]);
    expect(vi.isMockFunction(takenBack)).toBe(false);
  });
});
