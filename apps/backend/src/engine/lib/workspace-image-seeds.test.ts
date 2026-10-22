import { describe, it, expect } from 'vitest';
import { WORKSPACE_IMAGE_SEEDS, seedWorkspaceImages, type WorkspaceImageSpec } from './workspace-image-seeds.js';

const store = (rows: WorkspaceImageSpec[]) => {
  const saved: WorkspaceImageSpec[] = [];
  return {
    saved,
    getWorkspaceImages: async () => rows,
    saveWorkspaceImage: async (row: WorkspaceImageSpec) => { saved.push(row); },
  };
};

describe('seeding the shipped workspace images', () => {
  it('writes nothing when every shipped row already matches its seed', async () => {
    const current = store(WORKSPACE_IMAGE_SEEDS.map((seed) => ({ ...seed })));
    expect(await seedWorkspaceImages(current)).toBe(0);
  });

  it('brings a shipped row up to date with its seed, and never touches a person\'s own row', async () => {
    const odoo = WORKSPACE_IMAGE_SEEDS.find((seed) => seed.id === 'odoo')!;
    const stale = { ...odoo, available: odoo.available.filter((tool) => !tool.startsWith('helm')) };
    const mine = { ...odoo, ownerId: 'bo', summary: 'my own Odoo' };
    const current = store([...WORKSPACE_IMAGE_SEEDS.filter((seed) => seed.id !== 'odoo'), stale, mine]);

    expect(await seedWorkspaceImages(current)).toBe(1);
    expect(current.saved).toEqual([odoo]);
  });
});
