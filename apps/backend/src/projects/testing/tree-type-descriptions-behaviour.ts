import { describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import { seededPersonas, seededProcedures } from '../../extensions/seeds.js';
import { WORKSPACE_IMAGE_SEEDS } from '../../engine/lib/workspace-image-seeds.js';
import { restoringApp, type ReleaseAgent } from '../../releases/index.js';
import { TREE_TYPE_SEEDS, type TreeTypeSpec } from '../lib/tree-types.js';
import { TreeTypeDescriptions } from '../services/TreeTypeDescriptions.js';

const API_SERVICE = 'api-service';

const AGENTS: ReleaseAgent[] = [
  { slug: 'release', name: 'Release', description: 'Releases beside the live app.', needsApp: true },
  { slug: 'release-careful', name: 'Careful release', needsApp: true },
  { slug: 'release-replace', name: 'Replace', description: 'Deploys in place of the running app.', needsApp: false },
];

async function descriptionsFrom(make: () => Promise<Database>, withReleases: boolean) {
  const db = await make();
  for (const type of TREE_TYPE_SEEDS as TreeTypeSpec[]) await db.projects.saveTreeType(type);
  return {
    db,
    descriptions: new TreeTypeDescriptions({
      treeTypes: (ownerId) => db.projects.getTreeTypes(ownerId),
      images: async () => WORKSPACE_IMAGE_SEEDS,
      agentOf: async (_ownerId, agent) => {
        const persona = seededPersonas().find((entry) => entry.slug === agent);
        return persona && { describe: persona.description, procedure: seededProcedures().find((procedure) => procedure.id === persona.procedure) };
      },
      ...(withReleases ? { releaseAgents: async () => AGENTS, restores: restoringApp } : {}),
    }),
  };
}

export function treeTypeDescriptionsBehaviour(make: () => Promise<Database>): void {
  describe('a tree type describing itself to the planner', () => {
    it('tells how an Odoo tree grows from the shipped procedures\' own words, and what the platform does after', async () => {
      const { descriptions } = await descriptionsFrom(make, false);
      const text = (await descriptions.describe('u1', 'odoo-addons'))!;
      const growRun = seededProcedures().find((procedure) => procedure.id === 'grove-run')!;
      expect(text).toContain(growRun.describe);
      expect(text).toContain(`leaf-judge: ${seededPersonas().find((persona) => persona.slug === 'leaf-judge')!.description}`);
      expect(text).toContain('THE PLATFORM DOES THESE, SO NEVER PLAN THEM');
      expect(text).toContain(`executor: ${seededPersonas().find((persona) => persona.slug === 'executor')!.description}`);
    });

    it('uses a person\'s own copy of a type over the shipped one', async () => {
      const { db, descriptions } = await descriptionsFrom(make, false);
      const shipped = (TREE_TYPE_SEEDS as TreeTypeSpec[]).find((type) => type.id === API_SERVICE)!;
      await db.projects.saveTreeType({ ...shipped, ownerId: 'u1', summary: 'My own services.' });
      expect(await descriptions.describe('u1', API_SERVICE)).toContain('api-service): My own services.');
      expect(await descriptions.describe('u2', API_SERVICE)).not.toContain('My own services.');
    });

    it('knows no type it has not got', async () => {
      const { descriptions } = await descriptionsFrom(make, false);
      expect(await descriptions.describe('u1', 'nope')).toBeUndefined();
    });
  });

  describe('how a tree type is released, as the planner is told', () => {
    it('names the type\'s own way, the others that fit it beside the same app, and that the app can start from the client\'s own', async () => {
      const { descriptions } = await descriptionsFrom(make, true);
      expect(await descriptions.releasingOf('u1', 'odoo-addons')).toEqual({
        own: { slug: 'release', name: 'Release', description: 'Releases beside the live app.', app: 'odoo' },
        others: [{ slug: 'release-careful', name: 'Careful release', app: 'odoo' }],
        restores: { title: 'Odoo' },
      });
      const text = (await descriptions.describe('u1', 'odoo-addons'))!;
      expect(text).toContain('HOW IT IS RELEASED');
      expect(text).toContain('STARTING FROM THE CLIENT\'S OWN APP');
    });

    it('replaces the running app for a type with no chart, offering only the ways that replace it', async () => {
      const { descriptions } = await descriptionsFrom(make, true);
      expect(await descriptions.releasingOf('u1', API_SERVICE)).toEqual({
        own: { slug: 'release-replace', name: 'Replace', description: 'Deploys in place of the running app.' },
        others: [],
      });
    });

    it('says nothing of releasing for a type that makes an artefact, for a type it has not got, or where no agent releases', async () => {
      const { descriptions } = await descriptionsFrom(make, true);
      expect(await descriptions.releasingOf('u1', 'research-paper')).toBeUndefined();
      expect(await descriptions.releasingOf('u1', 'nope')).toBeUndefined();
      const bare = await descriptionsFrom(make, false);
      expect(await bare.descriptions.releasingOf('u1', 'odoo-addons')).toBeUndefined();
    });
  });
}
