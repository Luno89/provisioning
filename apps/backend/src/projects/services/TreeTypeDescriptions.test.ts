import { describe, it, expect } from 'vitest';
import { TreeTypeDescriptions } from './TreeTypeDescriptions.js';
import { seededPersonas, seededProcedures } from '../../extensions/seeds.js';
import { TREE_TYPE_SEEDS, type TreeTypeSpec } from '../lib/tree-types.js';
import { WORKSPACE_IMAGE_SEEDS } from '../../engine/lib/workspace-image-seeds.js';

const descriptions = (types: TreeTypeSpec[] = TREE_TYPE_SEEDS as TreeTypeSpec[]) => new TreeTypeDescriptions({
  treeTypes: async () => types,
  images: async () => WORKSPACE_IMAGE_SEEDS,
  agentOf: async (_ownerId, agent) => {
    const persona = seededPersonas().find((entry) => entry.slug === agent);
    return persona && { describe: persona.description, procedure: seededProcedures().find((procedure) => procedure.id === persona.procedure) };
  },
});

describe('a tree type describing itself to the planner', () => {
  it('tells how an Odoo tree grows from the shipped procedures\' own words, and what the platform does after', async () => {
    const text = (await descriptions().describe('u1', 'odoo-addons'))!;
    const growRun = seededProcedures().find((procedure) => procedure.id === 'grove-run')!;
    expect(text).toContain(growRun.describe);
    expect(text).toContain(`leaf-judge: ${seededPersonas().find((persona) => persona.slug === 'leaf-judge')!.description}`);
    expect(text).toContain('THE PLATFORM DOES THESE, SO NEVER PLAN THEM');
    expect(text).toContain(`executor: ${seededPersonas().find((persona) => persona.slug === 'executor')!.description}`);
  });

  it('uses a person\'s own copy of a type over the shipped one', async () => {
    const mine = { ...TREE_TYPE_SEEDS.find((type) => type.id === 'api-service')!, ownerId: 'u1', summary: 'My own services.' } as TreeTypeSpec;
    expect(await descriptions([...(TREE_TYPE_SEEDS as TreeTypeSpec[]), mine]).describe('u1', 'api-service')).toContain('api-service): My own services.');
  });

  it('knows no type it has not got', async () => {
    expect(await descriptions().describe('u1', 'nope')).toBeUndefined();
  });
});
