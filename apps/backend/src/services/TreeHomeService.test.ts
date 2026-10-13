import { describe, it, expect, beforeEach } from 'vitest';
import { TreeHomeService, dependsOn } from './TreeHomeService.js';
import type { NewProject } from './ProjectRepoService.js';
import type { ProjectMetadata } from '../lib/types.js';
import type { Tree } from '../lib/trees.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';

const type = (id: string, produces: 'service' | 'artefact', language = 'node'): TreeTypeSpec =>
  ({ id, label: id, summary: id, language, produces, doneMeans: 'done', files: [] }) as unknown as TreeTypeSpec;

const TYPES = [type('odoo-addons', 'service', 'odoo'), type('research-paper', 'artefact', 'base')];

let projects: ProjectMetadata[];
let created: { ownerId: string; project: NewProject }[];
let saved: Tree[];
let failCreate: boolean;

const service = () => new TreeHomeService({
  treeTypes: async () => TYPES,
  projects: async () => projects,
  createProject: async (ownerId, project) => {
    created.push({ ownerId, project });
    if (failCreate) throw new Error('Gitea is down');
    const made = { id: project.id!, name: project.name, ownerId, giteaOwner: 'koala-bo', giteaRepo: project.repo, createdAt: 'now' } as ProjectMetadata;
    projects.push(made);
    return made;
  },
  saveTree: async (tree) => { saved.push(tree); },
  starter: async (made, of) => [{ path: 'Dockerfile', content: `FROM ${made.id} for ${of.name}` }],
});

const tree = (over: Partial<Tree> = {}): Tree => ({ id: 'plan-1-tree', ownerId: 'bo', name: 'My Shop', type: 'odoo-addons', createdAt: 'then', updatedAt: 'then', ...over });

beforeEach(() => {
  projects = [];
  created = [];
  saved = [];
  failCreate = false;
});

describe('giving a new tree its home', () => {
  it('puts the secrets its type declares in the new project\'s vault once the tree is saved with it', async () => {
    const order: string[] = [];
    const homing = new TreeHomeService({
      treeTypes: async () => TYPES,
      projects: async () => projects,
      createProject: async (ownerId, project) => ({ id: project.id!, name: project.name, ownerId, createdAt: 'now' }) as ProjectMetadata,
      saveTree: async (saving) => { order.push(`saved with ${saving.projectIds?.join(',')}`); },
      starter: async () => [],
      secrets: { ensure: async (project, { type: made }) => { order.push(`secrets of ${project.id} for ${made.id}`); } },
    });
    await homing.home(tree());
    expect(order).toEqual(['saved with project-plan-1-tree', 'secrets of project-plan-1-tree for odoo-addons']);
    order.length = 0;
    await homing.home(tree({ type: 'research-paper' }));
    expect(order).toEqual([]);
  });

  it('makes a tree that produces a service its own project, starting from its type\'s files and deploying itself, and links it', async () => {
    const homed = await service().home(tree());
    expect(created).toEqual([{ ownerId: 'bo', project: { id: 'project-plan-1-tree', name: 'My Shop', repo: 'my-shop', language: 'odoo', autoDeployOnBuild: true, description: 'My Shop — the repository of tree plan-1-tree', starter: [{ path: 'Dockerfile', content: 'FROM odoo-addons for My Shop' }] } }]);
    expect(homed.projectIds).toEqual(['project-plan-1-tree']);
    expect(saved).toEqual([homed]);
  });

  it('leaves a tree that produces an artefact, or one with a project already, as it is', async () => {
    const paper = tree({ type: 'research-paper' });
    expect(await service().home(paper)).toBe(paper);
    const joined = tree({ projectIds: ['p9'] });
    expect(await service().home(joined)).toBe(joined);
    expect(created).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('numbers the repository when the person already has one of that name, and never looks at another person\'s', async () => {
    projects = [
      { id: 'p1', ownerId: 'bo', name: 'My Shop', giteaRepo: 'my-shop' } as ProjectMetadata,
      { id: 'p2', ownerId: 'someone', name: 'x', giteaRepo: 'my-shop-2' } as ProjectMetadata,
    ];
    await service().home(tree());
    expect(created[0]!.project.repo).toBe('my-shop-2');
  });

  it('finishes the project a failed attempt started, under the same repository name, rather than making a second', async () => {
    projects = [{ id: 'project-plan-1-tree', ownerId: 'bo', name: 'My Shop', giteaRepo: 'my-shop' } as ProjectMetadata];
    await service().home(tree());
    expect(created[0]!.project).toMatchObject({ id: 'project-plan-1-tree', repo: 'my-shop' });
  });

  it('saves nothing on the tree when the project cannot be made', async () => {
    failCreate = true;
    await expect(service().home(tree())).rejects.toThrow('Gitea is down');
    expect(saved).toEqual([]);
  });

  it('leaves the starter to whoever writes the first commit, when asked to, so a plan\'s starter and documents land as one build', async () => {
    await service().home(tree(), { starter: false });
    expect(created[0]!.project).not.toHaveProperty('starter');
  });
});


describe('the services a type says its app depends on', () => {
  it('become the new project\'s needs, added to any it has, never twice', () => {
    expect(dependsOn({}, { defaultBindings: ['shop-db'] })).toEqual([{ service: 'shop-db' }]);
    expect(dependsOn({ needs: [{ service: 'cache', as: 'redis' }] }, { defaultBindings: ['shop-db', 'cache'] })).toEqual([{ service: 'cache', as: 'redis' }, { service: 'shop-db' }]);
    expect(dependsOn({ needs: [{ service: 'shop-db' }] }, { defaultBindings: ['shop-db'] })).toBeUndefined();
    expect(dependsOn({}, {})).toBeUndefined();
  });

  it('are saved on the project when a tree of that type gets it', async () => {
    const saved: unknown[] = [];
    const homing = new TreeHomeService({
      treeTypes: async () => [{ ...type('odoo-addons', 'service', 'odoo'), defaultBindings: ['shop-db'] }],
      projects: async () => [],
      createProject: async (ownerId, project) => ({ id: project.id!, name: project.name, ownerId, createdAt: 'now' }) as ProjectMetadata,
      saveTree: async () => undefined,
      starter: async () => [],
      saveNeeds: async (project, needs) => { saved.push([project.id, needs]); },
    });
    await homing.home(tree());
    expect(saved).toEqual([['project-plan-1-tree', [{ service: 'shop-db' }]]]);
  });
});
