import { describe, it, expect, beforeEach } from 'vitest';
import { ReleaseSettings } from './ReleaseSettings.js';
import { REPLACE, SLOTS, SLOTS_ROLL_BACK } from '../extensions/releases/procedures.js';
import type { Procedure } from '@koala/agent-engine/procedure';
import type { ProjectMetadata } from '../lib/types.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';

const PROCEDURES: Record<string, Procedure> = { release: SLOTS, 'release-roll-back': SLOTS_ROLL_BACK, 'release-replace': REPLACE, my: { ...SLOTS, id: 'my-slots' } };

let types: TreeTypeSpec[];
let projects: ProjectMetadata[];
let charted: boolean;

const settings = () => new ReleaseSettings({
  agents: async () => [{ slug: 'koala', name: 'Koala' }, { slug: 'release', name: 'Release' }, { slug: 'release-replace', name: 'Release by replacing' }, { slug: 'release-roll-back', name: 'Release roll back' }, { slug: 'my', name: 'My release', description: 'mine' }],
  procedureOf: async (_owner, slug) => PROCEDURES[slug],
  treeTypes: async () => types,
  saveTreeType: async (type) => { types = [...types.filter((entry) => !(entry.id === type.id && entry.ownerId === type.ownerId)), type]; },
  projects: async () => projects,
  saveProject: async (project) => { projects = projects.map((entry) => (entry.id === project.id ? project : entry)); },
  typeOfProject: async () => types.find((entry) => entry.id === 'odoo-addons'),
  hasChart: async () => charted,
});

beforeEach(() => {
  types = [{ id: 'odoo-addons', label: 'Odoo', summary: 's', language: 'odoo', produces: 'service', doneMeans: 'd', files: [], release: { agent: 'release', app: 'odoo' } } as unknown as TreeTypeSpec];
  projects = [{ id: 'p1', name: 'Shop', ownerId: 'bo' } as ProjectMetadata];
  charted = true;
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
    const cleared = await settings().setForType('bo', 'odoo-addons', undefined);
    expect(cleared.ok && cleared.value.release).toBeUndefined();
    expect(await settings().setForType('bo', 'nope', undefined)).toEqual({ ok: false, status: 404, error: 'there is no tree type nope' });
  });

  it('says where a project\'s release comes from, lets the project override its type, and goes back to the type when cleared', async () => {
    expect(await settings().ofProject('bo', 'p1')).toEqual({ ok: true, value: { how: { agent: 'release', app: 'odoo' }, from: 'tree type' } });
    expect(await settings().setForProject('bo', 'p1', { agent: 'release-replace' })).toEqual({ ok: true, value: { how: { agent: 'release-replace' }, from: 'project' } });
    expect(await settings().setForProject('bo', 'p1', undefined)).toEqual({ ok: true, value: { how: { agent: 'release', app: 'odoo' }, from: 'tree type' } });
    types = [];
    charted = false;
    expect(await settings().ofProject('bo', 'p1')).toEqual({ ok: true, value: { how: { agent: 'release-replace' }, from: 'repository' } });
    expect(await settings().ofProject('cy', 'p1')).toEqual({ ok: false, status: 404, error: 'Project not found' });
    expect(await settings().setForProject('bo', 'p1', { agent: 'koala' })).toEqual({ ok: false, status: 400, error: 'koala is not an agent that releases builds' });
  });
});
