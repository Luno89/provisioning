import { describe, expect, it } from 'vitest';
import { WORKSPACE_IMAGE_SEEDS } from '../engine/lib/workspace-image-seeds.js';
import { builtLanguage } from '../projects/lib/tree-types.js';
import { WORKSPACE_BASES } from './workspace-bases.js';
import { SHIPPED_DEPENDENCIES } from './workspace-dependencies.js';
import { WORKSPACE_TOOLS, CHANGE_WORKSPACE } from './workspace/tools/catalogue.js';

describe('what a workspace is described as having', () => {
  it('is exactly what the base it is built from has, for every workspace a tree can work in', () => {
    for (const seed of WORKSPACE_IMAGE_SEEDS) {
      const base = WORKSPACE_BASES.find((candidate) => candidate.id === builtLanguage(seed.id));
      expect(base, `${seed.id} is described but nothing builds it`).toBeDefined();
      expect(seed.image, `${seed.id}'s image`).toBe(base!.image);
      expect(seed.available.map((entry) => entry.split(' ')[0]).sort(), `${seed.id}'s programs`).toEqual([...base!.provides].sort());
    }
  });

  it('offers to change_workspace only dependencies that exist', () => {
    const said = WORKSPACE_TOOLS.find((tool) => tool.name === CHANGE_WORKSPACE)!.parameters.properties.needs!.description;
    const listed = said.replace(/ \([^)]*\)/g, '').split('by name: ')[1]!.split(', and the person')[0]!.split(', ').map((entry) => entry.split(' ')[0]!);
    expect(listed).toEqual(['koala-e2e', 'playwright', 'jq', 'node', 'python', 'go']);
    const shipped = new Set(SHIPPED_DEPENDENCIES.map((dependency) => dependency.name));
    expect(listed.filter((name) => !shipped.has(name))).toEqual([]);
  });
});
