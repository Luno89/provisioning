import { beforeEach, describe, expect, it } from 'vitest';
import type { Procedure } from '@koala/agent-engine/procedure';
import { ReleaseSettings } from '../services/ReleaseSettings.js';
import { REPLACE, SLOTS, SLOTS_ROLL_BACK } from '../../extensions/releases/procedures.js';
import { treeTypeOfProject } from '../../projects/lib/tree-types.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { TreeTypeSpec } from '../../projects/lib/tree-types.js';

const PROCEDURES: Record<string, Procedure> = { release: SLOTS, 'release-roll-back': SLOTS_ROLL_BACK, 'release-replace': REPLACE, my: { ...SLOTS, id: 'my-slots' } };

export function releaseSettingsOver(db: Database, hasChart: () => boolean = () => true): ReleaseSettings {
  return new ReleaseSettings({
    agents: async () => [{ slug: 'koala', name: 'Koala' }, { slug: 'release', name: 'Release' }, { slug: 'release-replace', name: 'Release by replacing' }, { slug: 'release-roll-back', name: 'Release roll back' }, { slug: 'my', name: 'My release', description: 'mine' }],
    procedureOf: async (_owner, slug) => PROCEDURES[slug],
    treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
    saveTreeType: (type) => db.projects.saveTreeType(type),
    projects: () => db.projects.getProjects(),
    saveProject: (project) => db.projects.saveProject(project),
    typeOfProject: (project) => treeTypeOfProject(db.projects, project),
    hasChart: async () => hasChart(),
  });
}

export async function releaseSettingsWorld(db: Database, owner = 'bo'): Promise<void> {
  await db.projects.saveTreeType({ id: 'odoo-addons', label: 'Odoo', summary: 's', language: 'odoo', produces: 'service', doneMeans: 'd', files: [], release: { agent: 'release', app: 'odoo' } } as unknown as TreeTypeSpec);
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: owner, giteaOwner: owner, giteaRepo: 'shop', appType: 'gitapp', createdAt: 'x' });
  await db.projects.saveTree({ id: 't1', ownerId: owner, name: 'Shop', type: 'odoo-addons', projectIds: ['p1'], createdAt: 'x', updatedAt: 'x' } as never);
}

export function releaseSettingsBehaviour(make: () => Promise<Database>): void {
  let db: Database;
  let charted: boolean;

  const settings = () => releaseSettingsOver(db, () => charted);

  const stored = async (id: string) => (await db.projects.getProjects()).find((project) => project.id === id) as ProjectMetadata;

  beforeEach(async () => {
    db = await make();
    charted = true;
    await releaseSettingsWorld(db);
  });

  describe('what can release a build', () => {
    it('offers every agent whose procedure releases a build, never one that only rolls back, saying which need an app adapter, and the adapters there are', async () => {
      expect(await settings().options('bo')).toEqual({
        agents: [
          { slug: 'my', name: 'My release', description: 'mine', needsApp: true },
          { slug: 'release', name: 'Release', needsApp: true },
          { slug: 'release-replace', name: 'Release by replacing', needsApp: false },
        ],
        apps: [{ id: 'odoo', title: 'Odoo', restores: true }],
      });
    });

    it('refuses an agent that releases nothing, a slots release with no adapter, and a replace release with one', async () => {
      expect(await settings().problem('bo', { agent: 'koala' })).toBe('koala is not an agent that releases builds');
      expect(await settings().problem('bo', { agent: 'release' })).toBe('release releases beside the live app, so it needs the app\'s adapter (odoo)');
      expect(await settings().problem('bo', { agent: 'release-replace', app: 'odoo' })).toBe('release-replace replaces the running app, so it takes no app adapter');
      expect(await settings().problem('bo', { agent: 'my', app: 'wordpress' })).toBe('there is no release adapter called wordpress (there are odoo)');
      expect(await settings().problem('bo', { agent: 'my', app: 'odoo' })).toBeNull();
    });
  });

  describe('setting how builds are released', () => {
    it('keeps a tree type\'s setting as the person\'s own copy, and clears it', async () => {
      expect(await settings().setForType('bo', 'odoo-addons', { agent: 'my', app: 'odoo' })).toMatchObject({ ok: true, value: { ownerId: 'bo', release: { agent: 'my', app: 'odoo' } } });
      expect((await db.projects.getTreeTypes('bo')).find((type) => type.ownerId === 'bo')?.release).toEqual({ agent: 'my', app: 'odoo' });
      const cleared = await settings().setForType('bo', 'odoo-addons', undefined);
      expect(cleared.ok && cleared.value.release).toBeUndefined();
      expect((await db.projects.getTreeTypes('bo')).find((type) => type.ownerId === 'bo')?.release).toBeUndefined();
      expect(await settings().setForType('bo', 'nope', undefined)).toEqual({ ok: false, status: 404, error: 'there is no tree type nope' });
    });

    it('says where a project\'s release comes from, lets the project override its type, and goes back to the type when cleared', async () => {
      expect(await settings().ofProject('bo', 'p1')).toEqual({ ok: true, value: { how: { agent: 'release', app: 'odoo' }, from: 'tree type' } });
      expect(await settings().setForProject('bo', 'p1', { agent: 'release-replace' })).toEqual({ ok: true, value: { how: { agent: 'release-replace' }, from: 'project' } });
      expect((await stored('p1')).release).toEqual({ agent: 'release-replace' });
      expect(await settings().setForProject('bo', 'p1', undefined)).toEqual({ ok: true, value: { how: { agent: 'release', app: 'odoo' }, from: 'tree type' } });
      expect((await stored('p1')).release).toBeUndefined();
      await db.projects.deleteTree('t1');
      charted = false;
      expect(await settings().ofProject('bo', 'p1')).toEqual({ ok: true, value: { how: { agent: 'release-replace' }, from: 'repository' } });
      expect(await settings().ofProject('cy', 'p1')).toEqual({ ok: false, status: 404, error: 'Project not found' });
      expect(await settings().setForProject('bo', 'p1', { agent: 'koala' })).toEqual({ ok: false, status: 400, error: 'koala is not an agent that releases builds' });
    });
  });
}
