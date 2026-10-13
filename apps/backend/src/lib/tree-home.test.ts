import { describe, it, expect } from 'vitest';
import { needsProject, projectIdForTree, repoNameFor } from './tree-home.js';

describe('where a new tree lives', () => {
  it('gives a tree that produces a service a project, and one that produces an artefact none', () => {
    expect(needsProject({ produces: 'service' }, {})).toBe(true);
    expect(needsProject({ produces: 'artefact' }, {})).toBe(false);
    expect(needsProject(undefined, {})).toBe(false);
  });

  it('keeps the project a tree already has', () => {
    expect(needsProject({ produces: 'service' }, { projectIds: ['p1'] })).toBe(false);
    expect(needsProject({ produces: 'service' }, { projectIds: [] })).toBe(true);
  });

  it('names the project after its tree, so a retried creation finds the one it started', () => {
    expect(projectIdForTree('plan-abc-tree')).toBe('project-plan-abc-tree');
  });

  it('names the repository after the tree, numbering it when the name is taken', () => {
    expect(repoNameFor('My Shop', new Set())).toBe('my-shop');
    expect(repoNameFor('My Shop', new Set(['my-shop', 'my-shop-2']))).toBe('my-shop-3');
  });
});
